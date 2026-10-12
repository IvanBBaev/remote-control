/**
 * The agent's directories (D22): `env-paths('remotectl', {suffix: ''})` layout. Device
 * keys and `peers.json` live in `data`, the config file in `config`, logs in `log`.
 */
export interface AgentPaths {
  readonly data: string;
  readonly config: string;
  readonly cache: string;
  readonly log: string;
  readonly temp: string;
}
