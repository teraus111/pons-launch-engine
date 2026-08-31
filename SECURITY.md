# Security

## Wallet keys

- Use dedicated, minimally funded wallets.
- Never commit `.env`, `credentials.json`, credential vaults, or state files.
- Treat every example private key as public and never fund it.
- Prefer the encrypted vault for credentials stored on disk, with a unique
  password supplied outside source control.
- The included generator and vault commands never print private keys.
- Rotate any key that has been pasted into a public issue, chat, terminal log,
  or committed Git history.

The application reads keys locally to sign transactions. It does not include a
credential upload or remote backup feature.

## Reporting

Do not publish a vulnerability that could expose wallet funds. Report it to the
repository owner privately with reproduction steps and affected versions.

This project is unaudited. Contract interaction, RPC responses, dependency
updates, and operator configuration all remain part of the threat model.
