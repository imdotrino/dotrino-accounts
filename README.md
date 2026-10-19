# dotrino-accounts

El servicio de cuentas de Dotrino (`accounts.dotrino.com`): **vende, activa, renueva y apaga las
bóvedas alojadas** (una bóveda de Dotrino en AWS Lambda, $5/mes + IVA) y, más adelante, las
**réplicas alojadas** ($3/mes + IVA).

- Cobro: suscripción mensual de PayPal, por redirección (sin JavaScript de terceros en la página).
- Bóvedas: una pila de CloudFormation por cliente, con la plantilla de la release de
  `dotrino-vault` y una llave de KMS compartida. Apagar = concurrencia 0; no se borra nada.
- Quien manda en una suscripción es la cuenta de su bóveda: ver y cancelar van firmados por un
  aparato de esa cuenta.
- La compra se hace en la página de la bóveda, `vault.dotrino.com/hosted`; este servicio es solo la API.
- Nunca se vende dentro de una app nativa (iOS ni Android).
- Se administra desde `vault.dotrino.com/admin`, por una sesión cifrada de `@dotrino/remote-agent`
  (`kind: 'accounts'`), y solo desde un aparato con `admin` en el acta de Dotrino: ver todas las
  suscripciones, encender y apagar, devolver un cobro, añadir una réplica sin cargo a una cuenta
  y borrar una réplica (`docs/DISENO.md` §10).

Diseño: [`docs/DISENO.md`](docs/DISENO.md). Permisos de AWS: [`aws/`](aws/).

## Desarrollar

```bash
npm install
npm test
```

## Correr

```bash
dotrino-accounts enroll <invitación de: dotrino-vault pair --service accounts>
dotrino-accounts info
dotrino-accounts serve        # PORT (8095), ACCOUNTS_DB, ACCOUNTS_DIR, ACCOUNTS_SHOP_URL
```

La configuración sale entera del cajón `accounts` de la bóveda de Dotrino (lista en `server.js`).

Licencia MIT.
