# dotrino-accounts — la bóveda alojada de pago y quien administra las cuentas

> Pedido por el dueño el 2026-10-18. Decisiones tomadas ese día: **cobro mensual recurrente**,
> **$5/mes + IVA**, **la maestra sellada con la contraseña del cliente**, y **al dejar de pagar
> la bóveda se apaga y sus datos se conservan**. Es la **tercera excepción** de cobro
> (`MODELO-NEGOCIO.md`).

## 1. Qué es

Dos cosas que se necesitan una a la otra:

| | Qué hace |
|---|---|
| **La bóveda alojada** | una bóveda de Dotrino que corre en AWS Lambda (la de `dotrino-vault/lambda`, que ya existe), en la cuenta de AWS de Dotrino, una por cliente. Duerme y la despierta el proxio. |
| **`dotrino-accounts`** (`accounts.dotrino.com`) | el servicio que **vende, activa, renueva y apaga** esas bóvedas. Cobra, crea la pila, la apaga si no se paga y la vuelve a encender si se paga. |

Lo que se compra es **disponibilidad**: una bóveda siempre localizable sin tener un PC
encendido. La regla del ecosistema no cambia: **ninguna app exige la bóveda alojada**; el
aparato sigue siendo bóveda por defecto (`CLAUDE.md`, «El APARATO cumple el rol»).

## 2. Las reglas que no se negocian

1. **Dentro de una app nativa no se vende nada, ni en iOS ni en Android** (dueño, 2026-10-18;
   CONVENCIONES §16.5 para iOS, y Google Play exige su facturación para bienes digitales). Solo
   se compra desde el navegador. La compra y la gestión del pago se ocultan con una regla de
   `@dotrino/support/policy` que hay que añadir (`noPayments()`: true dentro de cualquier app
   nativa; `noDonations()` sigue siendo solo iOS). `accounts.dotrino.com` **no** entra en
   `ownHosts`. Lo gratis de la bóveda (usarla) sí se ve.
2. **Dotrino no ve la contraseña del cliente ni puede firmar por él.** La contraseña nunca
   pasa por `dotrino-accounts` ni por CloudFormation (hoy la plantilla la recibe como
   parámetro: eso cambia, §5).
3. **El perfil creado es quien manda en su suscripción.** Cancelar, ver el estado o cambiar el
   medio de pago son peticiones **firmadas por un aparato de ese perfil** (el mismo
   `signedRequest` de names). No hay usuario/contraseña de «cuenta de cliente» aparte.
4. **Apagar no borra.** Impago o cancelación → la bóveda deja de despertar; el bucket y la
   llave KMS se quedan. Pagar la reactiva tal cual estaba.
5. **Nada de repliegues.** Si `dotrino-accounts` no sabe el estado de una suscripción (PayPal
   no contesta), lo dice como «desconocido»; no la da por activa ni por cancelada.

## 3. Flujo de compra

> **La página de compra es la de la bóveda** (dueño, 2026-10-18: *«la página de compras debería
> accederse desde vault, ya que es para comprar vaults»*): `vault.dotrino.com/hosted`
> (`dotrino-vault/web/src/Hosted.vue`). `dotrino-accounts` es solo la API; su raíz redirige allí.
> Uso para la gente: `wiki.dotrino.com/vault/nube/`.

```
vault.dotrino.com/hosted ──1 POST /subscribe──▶ accounts ──▶ PayPal (crea la suscripción, plan $5.75/mes)
    │◀──────────── approveUrl ───────────────┘
    ├──2 aprueba en PayPal──▶ vuelve a vault.dotrino.com/hosted?sub=<id>
    ├──3 POST /confirm ─────▶ accounts: GET la suscripción en PayPal → ACTIVE y el plan nuestro
    │                         → crea la pila (CloudFormation, Name = id interno, sin contraseña)
    │                         → genera un CÓDIGO DE ACTIVACIÓN de un solo uso
    │◀── enlace vault.dotrino.com/activate#code=… ──┘   (en el #fragment: no llega a ningún servidor)
    └──4 activa: el navegador despierta la bóveda y, de punta a punta con ella (sellado),
         crea el perfil con SU contraseña y su primer aparato. La bóveda devuelve el id de la cuenta.
       5 POST /bind {code, req firmado por el aparato nuevo} → accounts ata la suscripción a esa cuenta
```

- **El código de activación** lo pone `dotrino-accounts` en la pila (Secrets Manager, como el
  `AdminPassword` de hoy) y la bóveda lo gasta en el primer arranque; después se reescribe a
  `used`. Quien tenga el código antes de usarlo puede activar la bóveda: por eso va en el
  `#fragment`, dura 7 días y solo sirve una vez.
- **El pedido no lleva datos del cliente.** A PayPal le llega el `custom_id` interno, como en
  names.
- Si el paso 3 falla (la pila no se crea), la fila queda `stack: 'failed'` con el primer recurso
  que falló en `note`, la suscripción se **cancela** y lo cobrado se **devuelve** (`refund`:
  `pending` → `done`). PayPal apunta el primer cobro minutos después de aprobar, así que la
  devolución la reintenta el barrido; a los 3 días sin cobro queda `none`.
- **Quién crea qué en AWS**: el usuario IAM `dotrino-accounts` (sin políticas administradas, solo
  `hosted-vaults`) crea la pila y le pasa el rol dedicado `dotrino-accounts-cfn`, que es quien crea
  lo de dentro (`hosted-vault-stacks`, acotado a `dotrino-vault-h*`). La llave admin no se usa
  para desplegar.

## 4. Renovar, cancelar, apagar, reactivar

| Evento | Cómo se entera | Qué hace |
|---|---|---|
| cobro del mes | webhook `PAYMENT.SALE.COMPLETED` | anota `paidThrough` |
| cobro fallido / suspendida | `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `.SUSPENDED` | PayPal reintenta; a los 15 días sin pago → **apaga** |
| cancelada por el cliente | petición firmada `op:'cancel'` → API de PayPal | sigue funcionando hasta `paidThrough`, y entonces **apaga** |
| cancelada/expirada en PayPal | `BILLING.SUBSCRIPTION.CANCELLED`, `.EXPIRED` | igual que la anterior |
| vuelve a pagar | suscripción nueva atada a la MISMA cuenta | **reactiva** |

- **Los webhooks se verifican** con `verify-webhook-signature` de PayPal. Y además un
  **barrido diario** pide a PayPal el estado de cada suscripción: el webhook avisa antes, pero
  no es la única fuente.
- **Apagar** = `PutFunctionConcurrency 0` en la función de esa bóveda: AWS deja de invocarla,
  es reversible al instante y no toca datos. **Reactivar** = `DeleteFunctionConcurrency`. El
  proxio recibe un error al despertarla; hay que comprobar que **no quita el timbre** (hoy lo
  quita con un 404, no con un 429: §7).
- **Con la bóveda apagada el perfil sigue pudiendo manejar su suscripción**: los aparatos del
  perfil tienen su llave y su cadena, y firman sin la bóveda.

## 5. La maestra, sellada con la contraseña del cliente

> Rehecho el 2026-10-19 sobre §8.bis: la bóveda de $5 ya no nace con un perfil nuevo, **entra en
> la cuenta del cliente** como segunda bóveda (`join`, con `sella`). Su maestra es una llave
> NUEVA, nacida en la Lambda, y es la que tiene que ir sellada. El dueño eligió **una contraseña
> nueva, puesta al comprar** (no la de la otra bóveda).

**En reposo** la maestra va sellada con la llave del perfil `K`, y `K` solo existe envuelta por la
llave que sale de la contraseña: `lock.json = { salt, params, wrapped: cifrar(K, scrypt(contraseña,
salt)) }`, en el directorio del perfil (que KMS cifra encima, y que se refleja en S3). Es el mismo
sobre que la «contraseña de administración» de la bóveda de escritorio (`dotrino-vault/docs/
abrir-a-distancia.md`), y por eso la consola ya sabe abrirla: **no hay protocolo nuevo para
abrir**. KMS sigue envolviendo el disco, pero ya no basta.

**Cerrada sirve**: commkey y sealkey van bajo KMS, como en el VPS. Identifica, entrega sobres y
replica. Lo que necesita la maestra (sellar el acta) contesta `vault-locked`.

**Abrir** = el «abrir a distancia» de siempre, desde la consola de tu cuenta con un aparato con
`admin`: la consola pide una llave efímera a la sesión de la Lambda (`unlock.begin`), deriva la
contraseña AQUÍ (scrypt) y manda solo la derivada sellada a esa efímera (`unlock`). La Lambda
desenvuelve `K`, abre la maestra y la tiene en memoria **mientras dure la sesión** (60 s sin
mensajes). Se dice sin esconderlo: durante esa sesión la maestra está en la memoria de una máquina
de AWS de Dotrino. En reposo, no.

> ⚠️ **PENDIENTE (2026-10-19): todavía no llega.** La bóveda está hecha para abrirse así (y lo hace,
> probado en `dotrino-vault/test/lambda-join.e2e.test.mjs`), pero el proxio solo entrega lo
> dirigido a la maestra de la bóveda que **es** el perfil —la primera—: a la de una segunda bóveda
> no la enruta nadie, así que la consola no le llega. Falta atar esa maestra a su llave de
> comunicación (la prueba está como `todo`). Mientras tanto la alojada sirve cerrada y entra
> abierta en el alta, que es cuando admite su llave de comunicación.

**Nacer** es lo único nuevo, porque la maestra no puede tocar el disco en claro ni un instante:

1. `/hosted`: el cliente pega la invitación de su bóveda (`pair --scope sealer`) y elige la
   contraseña (mínimo 12, como en escritorio).
2. `accounts` → Lambda `{ kind:'enroll', invitation }`: la Lambda lanza el alta, que crea una
   efímera **en memoria** y devuelve `{ ek, salt, params }`.
3. El navegador deriva y sella `{ nonce: req, key }` a `ek`. `accounts` lo pasa sin poder leerlo
   (`{ kind:'enroll-door', req, enc }`).
4. El alta abre el sobre, crea `K`, escribe `lock.json`, y **solo entonces** crea la identidad: la
   maestra nace sellada. Tira la efímera.
5. `join` a la cuenta del cliente, comprobando que la invitación es de **la cuenta que pagó**
   (`account`, como la réplica: con otra cuenta no hay código). La invitación la saca **cualquier
   bóveda de la cuenta que selle**, como para cualquier aparato (dueño, 2026-10-19). Devuelve el
   código y el cliente lo teclea en esa bóveda, que la admite con `sella`.

Lo que **no** se puede: recuperar la contraseña. Si se olvida, esa bóveda no vuelve a sellar; la
otra bóveda de la cuenta sigue sellando y puede quitarla. Cambiarla pide abrirla (pendiente).

Siguiente paso, y queda escrito: **sellar el acta en el navegador del cliente** (baja el sobre, lo
abre allí y sube el acta), para que la maestra no entre nunca en la Lambda.

## 6. Dónde corre `dotrino-accounts`

- **Node en proxy2**, igual que names: `node:http` + SQLite (`node:sqlite`), pm2, nginx con TLS y
  `access_log off`. Aparato del acta de Dotrino (`@dotrino/remote-agent/link`).
- **Secretos en su cajón `accounts`**: `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_LIVE`,
  `PAYPAL_PLAN_ID`, `PAYPAL_WEBHOOK_ID` y las llaves AWS.
- **Llaves AWS propias, acotadas**: un usuario IAM `dotrino-accounts` con permisos solo para las
  pilas `dotrino-vault-h*` (CloudFormation, Lambda de esas funciones, su `PutFunctionConcurrency`,
  S3/KMS/IAM/Secrets Manager que la plantilla crea). No la llave `admin`.
- **Cuenta y región**: AWS de Dotrino `147464502454`, `us-east-1`.
- **Tablas**: `subscriptions(id, paypalId, status, paidThrough, account, stack, activationExp, ts)`
  y `events(id, subscription, kind, raw, ts)` (cada webhook, para auditar).

**Reutilizar, no copiar** (sin código duplicado): los cobros van por **`@dotrino/pay`**
(`dotrino-pay`), el mismo paquete que usa names: el cliente de PayPal (pedidos, suscripciones,
webhooks), el precio con impuestos y los errores con código. Otro proveedor (PayPhone, Lightning)
entra ahí, no aquí. Lo firmado se comprueba con `verifySignedFor` del pilar de identidad.

## 7. Lo que hay que tocar en otras piezas

| Pieza | Cambio |
|---|---|
| `dotrino-vault/lambda` | código de activación en vez de `AdminPassword`; perfil con contraseña creado por el cliente; abrir la maestra en sesión (§5) |
| `dotrino-vault/web` (consola) | página `/activate`; sección «Suscripción» (estado, cancelar, pagar), oculta en iOS |
| `websocket-proxy` | un 429/«throttled» de la Function URL **no** quita el timbre (solo el 404) |
| `dotrino-home` | ficha en el catálogo, enlace a `accounts.dotrino.com` oculto en iOS |
| `dotrino-wiki` | página de uso: qué es, cómo se compra, cómo se cancela |
| `MODELO-NEGOCIO.md` | la tercera excepción (hecho) |
| `dotrino-roadmap` | producto `accounts` |

## 8. Fases

1. **`dotrino-accounts` con PayPal sandbox**: suscripción, webhook verificado, barrido, la pieza
   compartida de PayPal; crear y apagar/reactivar pilas en AWS con la plantilla actual.
2. **Activación sin contraseña en la Lambda** y página `/activate`.
3. **Maestra sellada con contraseña** y abrirla en sesión.
4. **Gestión desde el perfil** (consola: estado, cancelar) + iOS oculto + catálogo + wiki.
5. **PayPal Live**, plan real de $5.75, y la prueba de punta a punta con dinero.
6. Firmar el acta en el navegador (§5).

## 8.bis DECIDIDO (2026-10-19): nada nace vacío; todo entra en la cuenta que ya tienes

> El dueño, después de la primera compra de prueba: *«me entró a la cabeza el concepto de
> multivault que ya está soportado, y debería ser la forma correcta de crear un nuevo vault, no
> crear una vacía con un perfil»*. Y: *«lo bueno de crear una bóveda adicional desde el perfil
> actual es que no hay que cambiar nunca de perfil para gestionarla»*.

Cambia lo que dicen §3 y §5 sobre la bóveda alojada:

- **Se quita el modo «bóveda vacía con perfil nuevo»** (`admin@…` + código de activación) de
  `dotrino-accounts`. La plantilla lo conserva para quien monta la bóveda en su propio AWS.
- **Todo lo alojado ENTRA en la cuenta del cliente** con invitación + código (§9.1), y por eso la
  compra va firmada por esa cuenta: se ve, se cancela y se administra desde el perfil que ya usas.
- **Primero la réplica** ($3, §9): no tiene maestra, así que alguien con acceso a la cuenta de AWS
  no puede firmar por el cliente.
- **Después la segunda bóveda** ($5, el multivault de `dotrino-vault/docs/replicas.md` §1.bis:
  entra con `join`, tiene maestra y `+sealer`). **No sale a la venta hasta que su maestra vaya
  sellada con la contraseña del cliente** (§5): sin eso es un sellador abierto en la cuenta de
  Dotrino, que es justo lo que se desmontó en EC2 el 2026-09-02. Hecho el 2026-10-19 (vaultd
  0.168.0, `Mode: join`); falta abrirla a distancia (§5).
- La primera compra de prueba (2026-10-19) usó el modo viejo; esa bóveda (`h17005f242842`) se
  queda hasta su fecha pagada y no se crean más así.

## 9. Segundo producto: la réplica alojada ($3/mes + IVA)

> Pedido por el dueño el 2026-10-18: *«que se pueda agregar un vault o un replica, el replica
> cuesta menos»*. Precio decidido: **$3/mes + IVA = $3,45**.

Una réplica (`dotrino-vault replica`, `dotrino-vault/docs/replicas.md` §8.bis) **no crea un
perfil**: se suma a la cuenta que el cliente ya tiene. No tiene maestra, no sella nunca y no
puede abrir nada: entra al acta **sin llave de cifrado**. Lo que da es que la cuenta conteste
cuando su bóveda está apagada. Por eso se compra **firmada por la cuenta** (no hay `claim`): la
fila nace ya atada a `account`.

### 9.1. Cómo se enrola: con invitación, siempre

> Regla del dueño, 2026-10-18: **«ningún dispositivo debe poder enrolarse sin invitación»**. La
> réplica alojada no es la excepción: canjea una invitación y su código se aprueba como el de
> cualquier aparato. (Se descartó admitirla por su llave sin código.)

Primero se paga y después se enrola, porque una invitación caduca a los **5 minutos**
(`PAIRING_TTL_MS`) y PayPal más la creación de la pila se los comen:

1. **Compra firmada por la cuenta**: `POST /subscribe {req}` (`op:'subscribe'`,
   `product:'replica'`). La fila nace atada a `account`. PayPal vuelve a la página, que confirma
   (`POST /confirm {id, req}`) y la réplica se crea **vacía** (`Mode: replica`).
2. **La invitación la saca el cliente en su bóveda** cuando la réplica ya está lista:
   `dotrino-vault pair --scope replica --quiet`, o el botón de la consola que hace lo mismo.
3. **La página la manda**: `POST /enroll {id, invitation, req}`. `dotrino-accounts` se la pasa a
   la función (`{ kind:'enroll' }`): la réplica la canjea, pide su alta y deja el código en su
   almacén; la función lo devuelve (`{ deviceId, code }`) y la página lo enseña.
4. **El cliente aprueba el código en su bóveda**: `dotrino-vault approve <código>` o en la
   consola. La réplica guarda su enlace, recibe el acta y los sobres y registra su timbre, que es
   de SU llave (websocket-proxy ≥ 1.8.0).
5. **`/mine`** pregunta a la réplica si ya está enrolada (`{ kind:'status' }`, como mucho cada
   10 s) y lo enseña.

**Solo en la cuenta que la pagó, y en una sola** (dueño, 2026-10-19):

- **La réplica nace sabiendo quién la pagó**: la pila se crea con `Owner` = `account` de la fila
  (`pubkeyId` de la llave del perfil), y la función lo lee de su entorno. Nadie lo cambia
  después: ni la página ni quien invoque la función.
- **Rechaza la invitación de otra cuenta ANTES de enseñar el código.** La bóveda manda en el
  reto del alta su cadena de selladoras (vault ≥ 0.95.0); su raíz la firma la llave del perfil,
  así que no se puede fingir. Con otra cuenta no hay código y `/enroll` contesta `wrong-account`
  (409): no hay nada que aprobar. Una bóveda anterior no manda la cadena y la réplica tampoco
  entra.
- **No es multiperfil**: una vez enrolada rechaza cualquier otro emparejamiento
  (`already-enrolled`). La segunda bóveda (§8.bis) seguirá la misma regla.
- **La bóveda en el navegador es de un perfil** (identity ≥ 0.123.0): el interruptor guarda de
  qué perfil es, y la bóveda no arranca si la cuenta abierta en la pestaña no sella su acta
  (una entrada con usuario y contraseña). Así la invitación del botón «sacar la invitación en
  este navegador» es siempre de la cuenta que firma la compra.
- **La bóveda nunca manda invitaciones por la red ni recibe el PIN** (dueño, 2026-10-19). Con
  una bóveda externa se copia la invitación y se teclea el código allí; solo cuando la bóveda
  es el mismo navegador la página las pasa por dentro.

**Si falla** (no se aprobó a tiempo, invitación caducada o gastada):

- **Reenrolar**: el cliente saca otra invitación y la página la manda otra vez (paso 3). Una
  réplica ya enrolada no se vuelve a enrolar.
- **O se borra el despliegue**: si a las 24 h no hay réplica enrolada, se cancela la suscripción
  en PayPal, se devuelve lo cobrado y se borra la pila (`DeleteStack`; el bucket se queda, no
  cuesta). Nada queda corriendo ni cobrándose sin réplica. Las pilas siguen siendo
  `dotrino-vault-h*`: así valen los mismos permisos y el mismo límite.

La segunda bóveda (§8.bis) pasa por el mismo camino, con `join` en vez de `replica enroll`.

### 9.2. Lo que hay que tocar

| Pieza | Cambio |
|---|---|
| `dotrino-vault/lambda` | HECHO (vaultd 0.166.0): `Mode: replica`; `{ kind:'enroll' }` y `{ kind:'status' }`; las sesiones corren el replicador |
| `dotrino-vault` (consola) | botón «Añadir réplica alojada» (saca la invitación y abre la compra) y el pendiente con su código |
| `websocket-proxy` | HECHO (1.8.0, proxy-client 0.39.0: `registerWake({ self })`). Antes: el timbre se guardaba para la CUENTA (`push-subscribe` `kind:'wake'` → `profileId`), y una réplica no entra como la cuenta: se identifica con SU llave, y el cliente le escribe a esa llave cuando la bóveda no contesta (`fetchSecrets`, `targets`). Hace falta un timbre para la llave propia, firmado por ella: un mensaje encolado para la réplica la despierta |
| `dotrino-accounts` | HECHO (0.3.0): fuera el modo de perfil nuevo; `product: 'replica'` (y `'vault'` cuando §5 exista); todo firmado por la cuenta; `/enroll`; borrar a las 24 h; plan de PayPal de $3,45 (`PAYPAL_REPLICA_PLAN_ID`) |

## 10. Administración desde el perfil de Dotrino

> Pedido del dueño, 2026-10-19. HECHO en 0.5.0 (con `@dotrino/remote-agent` 0.23.0).

La cuenta de AWS es de Dotrino, así que el perfil de Dotrino administra lo que este servicio
vende. La página es **`vault.dotrino.com/admin`**, una vista más de la consola de la bóveda.

- **Por dónde.** El servicio arranca, con el mismo enlace con que se enroló (`identityDir()`),
  un agente de `@dotrino/remote-agent` con `label: 'accounts'`. La página pregunta a los
  miembros del acta de la cuenta abierta (`listAgentsByLabel` + `probeAgents`) y se queda con
  los que contestan `kind: 'accounts'`. **El enlace del menú solo sale si el acta tiene algún
  servicio `accounts`**: para cualquier otra cuenta no aparece nada. Puede haber varios
  (sandbox y live); se listan todos y al abrir uno se ve lo que administra ese.
- **Quién puede.** Abrir sesión ya exige ser del acta y poder firmar. Administrar exige además
  **`admin`** en el acta de Dotrino, y el servicio lo pregunta **en cada petición** al acta de
  confianza del agente (`ra.checkCap(session.device, 'admin')`), nunca a lo que diga la página.
  Si no pasa, el agente trae el acta en el momento (un permiso recién dado no espera al tic de
  5 min). Sin `admin`: `forbidden`; sin acta de confianza: `no-record`.
- **El protocolo**, dentro de la sesión cifrada (`src/admin.js`):

  ```
  → { type: 'admin', rid, op, args }
  ← { type: 'admin.result', rid, ok: true, result }
  ← { type: 'admin.result', rid, ok: false, code, error }
  ```

  | `op` | `args` | Qué hace |
  |---|---|---|
  | `list` | — | todas las suscripciones y réplicas, de todas las cuentas |
  | `setOn` | `{ id, on }` | `on: true/false` enciende o apaga a mano **por encima del pago** (columna `admin_on`); `on: null` lo suelta y vuelve a mandar el pago |
  | `refund` | `{ id }` | devuelve el **último** cobro completado **y cancela** la suscripción (dueño, 2026-10-19): sigue hasta el fin de lo pagado y se apaga |
  | `addReplica` | `{ account }` | crea una réplica **sin cargo** (`status: 'COMP'`, sin PayPal) con `Owner` = `account` (`pubkeyId` de la llave del perfil, 64 hex) |
  | `remove` | `{ id }` | borra la pila. Si la suscripción sigue viva, la cancela antes (devolver es aparte) |

  Cada operación queda en el log en inglés, con el ID del aparato que la pidió.
- **Añadir una réplica a un perfil** no la ata a nada: nace con `Owner` = esa cuenta, sale en el
  `/mine` de esa cuenta, y el cliente la enrola desde su `/hosted` con su invitación y su código,
  como una comprada. **No hay otra forma** de atar una bóveda a un perfil que ya existe. Como
  cualquier réplica, si nadie la enrola en 24 h se borra.
- **Lo que no es una suscripción no se le pregunta a PayPal**: `confirm`, `cancel` y `refund`
  de una réplica sin cargo contestan `no-subscription` (409).

## 11. Abierto

- **Lo que todavía puede la llave del servicio, con el límite puesto** (2026-10-19). Los roles de
  las pilas llevan el límite `dotrino-vault-boundary` (`aws/vault-role-boundary.json`) y el rol de
  CloudFormation solo crea roles que lo lleven, así que ya no se puede fabricar un rol con más
  permisos. Pero el límite es el mismo para todas las bóvedas: quien robe la llave del servicio y
  monte otra plantilla puede crear una Lambda que lea los buckets `dotrino-vault-h*` y use la
  llave compartida con el nombre de OTRA bóveda en el contexto. Lo que sacaría es el disco
  cifrado de esa bóveda, no la maestra (que va sellada con la contraseña del cliente, fase 3).
  Cerrarlo del todo pide atar el rol a SU bóveda (etiqueta del rol = nombre, y el límite con
  `${aws:PrincipalTag/…}`), con la condición de que nadie pueda poner la etiqueta de otra.

- **Factura del SRI** por cada cobro mensual: emisor autorizado (facturero), aparte del cobro.
- **Moneda y precio**: $5 + 15 % IVA = **$5.75/mes**, cobrado en USD.
- **Coste por cliente**: llave KMS $1/mes + S3 y Lambda de céntimos; la comisión de PayPal
  (~5,4 % + $0,30) se come ~$0,60.
