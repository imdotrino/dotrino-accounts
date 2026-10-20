/**
 * Las réplicas y bóvedas alojadas, en AWS: una pila de CloudFormation por cada una, con la plantilla de la
 * release de `dotrino-vault` (`lambda/template.yaml`) y la llave de KMS COMPARTIDA
 * (`SharedKeyArn`: $1/mes en total, y cada bóveda solo puede usarla con su nombre).
 *
 * Encender y apagar es la concurrencia de su función: con 0, AWS no la invoca (no despierta) y
 * no se toca nada de lo guardado; quitarla la deja como estaba. Es reversible al instante.
 *
 * Los permisos van en dos sitios (`aws/`): la llave del servicio solo crea y mira pilas
 * `dotrino-vault-h*` y enciende o apaga esas funciones; lo que la pila crea lo crea el ROL de
 * CloudFormation (`cfnRoleArn`), acotado a los mismos nombres. Apagar nunca borra; borrar
 * (`remove`) es solo para una réplica que nadie enroló, que no tiene nada de nadie.
 *
 * Los roles de la bóveda llevan un LÍMITE de permisos (`roleBoundaryArn`, `aws/vault-role-
 * boundary.json`), y el rol de CloudFormation solo puede crear roles que lo lleven. Sin eso,
 * con la llave del servicio y otra plantilla se podía crear un rol con cualquier permiso y
 * dárselo a una Lambda.
 *
 * La plantilla se baja de una URL fija y se comprueba su sha256 antes de usarla: el servicio
 * crea en la cuenta de Dotrino exactamente lo que dice la release, y nada más.
 */
import { createHash } from 'node:crypto'
import { CloudFormationClient, CreateStackCommand, DeleteStackCommand, DescribeStacksCommand, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation'
import { LambdaClient, InvokeCommand, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand } from '@aws-sdk/client-lambda'

export const stackName = (vault) => `dotrino-vault-${vault}`
export const functionName = (vault) => `dotrino-vault-${vault}`

export function awsVaults ({ region, credentials, templateUrl, templateSha256, sharedKeyArn, cfnRoleArn, roleBoundaryArn, fetch = globalThis.fetch }) {
  for (const [k, v] of Object.entries({ region, templateUrl, templateSha256, sharedKeyArn, cfnRoleArn, roleBoundaryArn })) {
    if (!v) throw Object.assign(new Error(`vaults: ${k} is required`), { code: 'vaults-misconfigured' })
  }
  const cfn = new CloudFormationClient({ region, credentials })
  const lambda = new LambdaClient({ region, credentials })
  let template = null

  async function templateBody () {
    if (template) return template
    const res = await fetch(templateUrl)
    if (!res.ok) throw Object.assign(new Error(`vaults: template ${res.status} at ${templateUrl}`), { code: 'template-unavailable' })
    const body = await res.text()
    const sha = createHash('sha256').update(body).digest('hex')
    if (sha !== templateSha256) throw Object.assign(new Error(`vaults: template sha256 ${sha} is not the expected one`), { code: 'template-mismatch' })
    template = body
    return template
  }

  // El estado final de una pila rota dice cómo acabó el ROLLBACK, no por qué empezó: la causa
  // es el primer recurso que falló al crearse, y esa está en los eventos.
  async function firstFailure (vault) {
    const r = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName(vault) }))
    const e = (r.StackEvents || []).filter((x) => x.ResourceStatus === 'CREATE_FAILED' && x.ResourceStatusReason).at(-1)
    return e ? ` · first failure: ${e.LogicalResourceId}: ${e.ResourceStatusReason}` : ''
  }

  return {
    /**
     * Una pila vacía que espera a que su dueño la enrole: una réplica (`mode: 'replica'`) o una
     * segunda bóveda (`'join'`). `owner` es la cuenta que la pagó: nace sabiéndolo y rechaza la
     * invitación de cualquier otra.
     */
    async create ({ vault, owner, mode }) {
      if (!/^[0-9a-f]{64}$/.test(owner || '')) throw Object.assign(new Error(`vaults: no owner for ${vault}`), { code: 'no-owner' })
      if (mode !== 'replica' && mode !== 'join') throw Object.assign(new Error(`vaults: no stack mode ${mode}`), { code: 'bad-mode' })
      await cfn.send(new CreateStackCommand({
        StackName: stackName(vault),
        TemplateBody: await templateBody(),
        Capabilities: ['CAPABILITY_IAM'],
        RoleARN: cfnRoleArn,
        Parameters: [
          { ParameterKey: 'Name', ParameterValue: vault },
          { ParameterKey: 'Mode', ParameterValue: mode },
          { ParameterKey: 'Owner', ParameterValue: owner },
          { ParameterKey: 'SharedKeyArn', ParameterValue: sharedKeyArn },
          { ParameterKey: 'PermissionsBoundary', ParameterValue: roleBoundaryArn }
        ],
        Tags: [{ Key: 'dotrino', Value: 'hosted-vault' }]
      }))
    },

    /** @returns {Promise<{ state:'creating'|'ready'|'failed', reason?:string }>} */
    async describe (vault, mode) {
      const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName(vault) }))
      const s = r.Stacks?.[0]
      if (!s) throw Object.assign(new Error(`vaults: no stack for ${vault}`), { code: 'stack-not-found' })
      if (/_IN_PROGRESS$/.test(s.StackStatus) && !/ROLLBACK/.test(s.StackStatus)) return { state: 'creating' }
      if (s.StackStatus === 'CREATE_COMPLETE' || s.StackStatus === 'UPDATE_COMPLETE') {
        const out = Object.fromEntries((s.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]))
        if (out.Mode !== mode) throw Object.assign(new Error(`vaults: stack ${vault} runs ${out.Mode}, not ${mode} (template too old?)`), { code: 'stack-outputs' })
        return { state: 'ready' }
      }
      return { state: 'failed', reason: `${s.StackStatus}${s.StackStatusReason ? ': ' + s.StackStatusReason : ''}${await firstFailure(vault)}` }
    },

    /** Le habla a la función (`{ kind:'enroll' | 'enroll-door' | 'status' }`) y devuelve lo que conteste. */
    async invoke (vault, payload) {
      const r = await lambda.send(new InvokeCommand({ FunctionName: functionName(vault), InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(payload)) }))
      if (r.FunctionError) throw Object.assign(new Error(`vaults: ${vault} failed on ${payload.kind}: ${r.FunctionError}`), { code: 'function-error' })
      return JSON.parse(Buffer.from(r.Payload || '').toString('utf8') || 'null')
    },

    /** Borra la pila (las que nadie enroló). El bucket se queda: lo retiene la plantilla. */
    async remove (vault) {
      await cfn.send(new DeleteStackCommand({ StackName: stackName(vault), RoleARN: cfnRoleArn }))
    },

    async setOn (vault, on) {
      if (on) await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName(vault) }))
      else await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName(vault), ReservedConcurrentExecutions: 0 }))
    }
  }
}
