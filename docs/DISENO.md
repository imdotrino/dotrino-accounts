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
- Si el paso 3 falla a mitad (la pila no se crea), la suscripción queda `provisioning-failed`,
  se ve en la página y se reintenta; no se cobra un segundo mes sin bóveda: se cancela.

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

Hoy la Lambda guarda la maestra bajo KMS sin contraseña (`lambda/README.md`, «Lo que falta» 3):
quien controle la cuenta de AWS de Dotrino puede abrirla. Con eso no se puede vender.

Lo que cambia:

- **En reposo**, la maestra se guarda **sellada con la contraseña del perfil**, como en la bóveda
  de escritorio. KMS sigue envolviendo el disco, pero ya no basta para abrir la maestra.
- **Cerrada sigue sirviendo** (commkey y sealkey bajo KMS): se identifica, entrega sobres, hace
  login. Es lo mismo que la bóveda del VPS hoy.
- **Abrir para firmar el acta** (admitir o quitar un aparato, cambiar permisos) lo hace el
  cliente desde su consola: la contraseña viaja **sellada de punta a punta** a la sesión de la
  Lambda, se abre en su memoria, firma, y **se cierra al acabar la sesión** (60 s sin
  mensajes). Lo que se dice sin esconderlo: **durante esa sesión** la maestra está en la memoria
  de una máquina de AWS de Dotrino. En reposo, no.
- Mejor todavía, y queda como siguiente paso: **firmar el acta en el navegador del cliente**
  (baja el sobre de la maestra, lo abre con su contraseña allí, firma y sube el acta). Así la
  maestra no entra nunca en la Lambda. Requiere que la consola web sepa sellar actas.

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

1. **La invitación la saca el cliente en su bóveda**: `dotrino-vault pair --scope replica --quiet`
   o el botón «Añadir réplica alojada» de la consola, que hace lo mismo.
2. **La compra la lleva**: `POST /subscribe {product:'replica', invitation, req}`, con `req`
   firmado por la cuenta. `dotrino-accounts` comprueba que la invitación es de ESA cuenta antes
   de cobrar nada (el `hello` de la invitación dice de qué bóveda es, `vaultHello`; ojo, gasta
   la cita: se pasa a la pila ya enriquecida).
3. **La pila la canjea en su primer arranque** (`Mode: replica`, parámetro `Invitation`,
   NoEcho). La réplica envía su alta con un código aleatorio, igual que hoy.
4. **El código sale por la pila sin esperar**: el recurso del primer arranque contesta a
   CloudFormation en cuanto la bóveda le pide el código (Outputs `DeviceId` y `PairingCode`), y
   la misma invocación sigue esperando el «enrolado» hasta 12 minutos. `dotrino-accounts` lo lee
   y la página lo enseña; la consola del cliente lo enseña junto a «pendiente».
5. **El cliente lo aprueba en su bóveda**: `dotrino-vault approve <código>` o en la consola.
   La réplica guarda su enlace en S3 y ya es una réplica más.

**Si falla** (no se aprobó a tiempo, invitación caducada o gastada):

- **Reenrolar**: el cliente saca otra invitación y la página la manda; `dotrino-accounts`
  actualiza la pila con la `Invitation` nueva (`UpdateStack`) y el recurso vuelve a canjear.
  Mismo flujo, mismo código nuevo.
- **O se borra el despliegue**: si a las 24 h no hay réplica enrolada, se cancela la suscripción
  en PayPal y se borra la pila (`DeleteStack`, solo de pilas de réplica `dotrino-vault-r*`; el
  bucket vacío se queda, no cuesta). Nada queda corriendo ni cobrándose sin réplica.

La bóveda alojada **no** pasa por aquí: no entra a una cuenta, crea la suya. Su primer acceso es
el login con contraseña del §5 (el código de activación hace de contraseña inicial).

### 9.2. Lo que hay que tocar

| Pieza | Cambio |
|---|---|
| `dotrino-vault/lambda` | `Mode: replica` en la plantilla (sin perfil ni maestra) con `Invitation`; el primer arranque canjea, da `DeviceId`/`PairingCode` y espera el «enrolado»; las sesiones corren `replica run` |
| `dotrino-vault` (consola) | botón «Añadir réplica alojada» (saca la invitación y abre la compra) y el pendiente con su código |
| `websocket-proxy` | despertar también a una réplica de la cuenta (hoy `registerWake` lo firma la llave de comunicación de la bóveda; hay que admitirlo de un miembro con `replica`) |
| `dotrino-accounts` | `product: 'vault' \| 'replica'`; la compra de réplica va firmada por la cuenta, con la invitación; reenrolar (`UpdateStack`) y borrar a las 24 h; planes de PayPal aparte |

## 10. Abierto

- **Factura del SRI** por cada cobro mensual: emisor autorizado (facturero), aparte del cobro.
- **Moneda y precio**: $5 + 15 % IVA = **$5.75/mes**, cobrado en USD.
- **Coste por cliente**: llave KMS $1/mes + S3 y Lambda de céntimos; la comisión de PayPal
  (~5,4 % + $0,30) se come ~$0,60.
