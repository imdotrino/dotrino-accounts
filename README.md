# dotrino-accounts

El servicio de cuentas de Dotrino (`accounts.dotrino.com`): **vende, activa, renueva y apaga las
bóvedas alojadas** (una bóveda de Dotrino en AWS Lambda, $5/mes + IVA) y, más adelante, las
**réplicas alojadas** ($3/mes + IVA).

- Cobro: suscripción mensual de PayPal, por redirección (sin JavaScript de terceros en la página).
- Bóvedas: una pila de CloudFormation por cliente, con la plantilla de la release de
  `dotrino-vault` y una llave de KMS compartida. Apagar = concurrencia 0; no se borra nada.
- Quien manda en una suscripción es la cuenta de su bóveda: ver y cancelar van firmados por un
  aparato de esa cuenta.
- Nunca se vende dentro de una app nativa (iOS ni Android).

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
dotrino-accounts serve        # PORT (8095), ACCOUNTS_DB, ACCOUNTS_DIR, ACCOUNTS_PUBLIC_URL
```

La configuración sale entera del cajón `accounts` de la bóveda de Dotrino (lista en `server.js`).

Licencia MIT.
