# Install LessCode

## Requirements

- Node.js **22 or later**, npm and Git available to the process running LessCode.
- A model provider with the required tool-capable OpenAI Chat Completions interface; see [provider setup](providers.md).
- Docker CLI and a running Docker engine for isolated execution, fetched GitHub reviews or hosted workers. Trusted local mode can run without Docker.
- An npm-based target project for the built-in Docker dependency installer. Other package managers require a compatible executor; setting a base URL does not add that support.

Check local prerequisites:

```sh
node --version
npm --version
git --version
# Only needed for isolated execution:
docker version
```

No model credential or request is needed for installation or `--help`.

## Build a checkout

```sh
git clone https://github.com/Mariotutal/lesscode.git
cd lesscode
npm ci
npm run build
node ./bin/lesscode --help
```

`npm ci` installs the dependency versions in the lockfile. Build generates `dist/`. Keep the source checkout's dependencies installed while using its commands. From this checkout, `node ./bin/lesscode` runs the built public CLI; there is no need to link a global command.

The npm package has `private: true` and version `0.0.0`. Do not assume `npm install -g lesscode` downloads this implementation from a registry. Install a tarball produced from the revision you reviewed.

## Install the command from a tarball

From the built LessCode checkout:

```sh
npm pack
```

For this version the output archive is `lesscode-0.0.0.tgz`; use the actual filename printed by npm. `prepack` rebuilds the distribution. Put release archives outside a reviewed project so they do not become accidental review inputs.

For a user-owned prefix on macOS or Linux:

```sh
npm install --global --prefix "$HOME/.local" /absolute/path/to/lesscode-0.0.0.tgz
export PATH="$HOME/.local/bin:$PATH"
lesscode --help
```

Add the PATH entry to the shell startup file you use if you want it in later terminals. Agent desktop processes need their own PATH/environment configuration; changing a terminal does not update an already-running GUI process. For another OS, choose an npm prefix you own and put that prefix's executable directory on PATH.

Verify which executable will run:

```sh
command -v lesscode
npm root --global --prefix "$HOME/.local"
```

The tarball contains the runtime, executable and portable skill; full documentation stays in the source checkout/site. The second command prints the installed package root. The built MCP entrypoint is `<that-root>/lesscode/dist/mcp/cli.js`; record its **absolute path** when configuring a client.

## Prepare Docker mode

From the LessCode checkout:

```sh
docker build -f docker/runner.Dockerfile -t lesscode-runner:local .
docker image inspect lesscode-runner:local --format '{{.Id}}'
```

Image creation can access the image/package registries. Review execution requires the approved image to exist locally and does not automatically pull it. Dependency preparation installs npm dependencies with lifecycle scripts disabled; subsequent repository verification commands run without network access. The executor records the inspected immutable image identity.

Run source you do not trust only with an isolated executor. For a private hosted deployment, use a dedicated disposable execution host; the local Docker mode is not a claim of proven hostile multi-tenant isolation.

## Configure credentials and first use

Load `LESSCODE_API_KEY` into the operator environment through your secret store or shell setup, then follow [Providers](providers.md). LessCode does not automatically load `.env`, and a local `.lesscode.json` can name an environment variable but cannot contain a literal key. The installation process does not retrieve credentials for you.

Continue with [Run a review](run.md), or [connect MCP and a portable skill](consumers.md). The [hosted guide](hosted-deployment.md) covers service tokens, GitHub authorization and worker configuration separately.

## Update

For a source checkout, preserve your local changes, fetch the new revision, then reinstall and rebuild:

```sh
git pull --ff-only
npm ci
npm run build
node ./bin/lesscode --help
```

If you installed a tarball, build/pack the reviewed new revision and install that archive into the same prefix. The version remains `0.0.0`, so record the Git commit and archive SHA-256 in your own release notes; the filename alone does not identify a revision. Restart MCP servers and services after replacing their installation. Review [validation status](validation.md) before a deployment change.

## Uninstall

```sh
npm uninstall --global --prefix "$HOME/.local" lesscode
```

Remove the corresponding MCP/skill registration from your agent host. Source checkouts, result files, local evaluation artifacts and service data are separate from the global package; preserve or remove those deliberately. Never delete an active service's data directory as an uninstall step.
