/**
 * Las bóvedas alojadas, en AWS: una pila de CloudFormation por bóveda, con la plantilla de la
 * release de `dotrino-vault` (`lambda/template.yaml`) y la llave de KMS COMPARTIDA
 * (`SharedKeyArn`: $1/mes en total, y cada bóveda solo puede usarla con su nombre).
 *
 * Encender y apagar es la concurrencia de su función: con 0, AWS no la invoca (no despierta) y
 * no se toca nada de lo guardado; quitarla la deja como estaba. Es reversible al instante.
 *
 * Los permisos van en dos sitios (`aws/`): la llave del servicio solo crea y mira pilas
 * `dotrino-vault-h*` y enciende o apaga esas funciones; lo que la pila crea lo crea el ROL de
 * CloudFormation (`cfnRoleArn`), acotado a los mismos nombres. Borrar una pila no lo puede nadie
 * desde aquí: apagar nunca borra.
 *
 * La plantilla se baja de una URL fija y se comprueba su sha256 antes de usarla: el servicio
 * crea en la cuenta de Dotrino exactamente lo que dice la release, y nada más.
 */
import { createHash } from 'node:crypto'
import { CloudFormationClient, CreateStackCommand, DescribeStacksCommand, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation'
import { LambdaClient, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand } from '@aws-sdk/client-lambda'

export const stackName = (vault) => `dotrino-vault-${vault}`
export const functionName = (vault) => `dotrino-vault-${vault}`

export function awsVaults ({ region, credentials, templateUrl, templateSha256, sharedKeyArn, cfnRoleArn, fetch = globalThis.fetch }) {
  for (const [k, v] of Object.entries({ region, templateUrl, templateSha256, sharedKeyArn, cfnRoleArn })) {
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
    async create ({ vault, adminPassword }) {
      await cfn.send(new CreateStackCommand({
        StackName: stackName(vault),
        TemplateBody: await templateBody(),
        Capabilities: ['CAPABILITY_IAM'],
        RoleARN: cfnRoleArn,
        Parameters: [
          { ParameterKey: 'Name', ParameterValue: vault },
          { ParameterKey: 'AdminPassword', ParameterValue: adminPassword },
          { ParameterKey: 'SharedKeyArn', ParameterValue: sharedKeyArn }
        ],
        Tags: [{ Key: 'dotrino', Value: 'hosted-vault' }]
      }))
    },

    /** @returns {Promise<{ state:'creating'|'ready'|'failed', login?:string, account?:string, reason?:string }>} */
    async describe (vault) {
      const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName(vault) }))
      const s = r.Stacks?.[0]
      if (!s) throw Object.assign(new Error(`vaults: no stack for ${vault}`), { code: 'stack-not-found' })
      if (/_IN_PROGRESS$/.test(s.StackStatus) && !/ROLLBACK/.test(s.StackStatus)) return { state: 'creating' }
      if (s.StackStatus === 'CREATE_COMPLETE' || s.StackStatus === 'UPDATE_COMPLETE') {
        const out = Object.fromEntries((s.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]))
        if (!out.Login || !/^[0-9a-f]{64}$/.test(out.Account || '')) throw Object.assign(new Error(`vaults: stack ${vault} has no Login/Account outputs (template too old?)`), { code: 'stack-outputs' })
        return { state: 'ready', login: out.Login, account: out.Account }
      }
      return { state: 'failed', reason: `${s.StackStatus}${s.StackStatusReason ? ': ' + s.StackStatusReason : ''}${await firstFailure(vault)}` }
    },

    async setOn (vault, on) {
      if (on) await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName(vault) }))
      else await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: functionName(vault), ReservedConcurrentExecutions: 0 }))
    }
  }
}
