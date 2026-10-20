import path from 'node:path';
import Docker from 'dockerode';
import type { Config } from '../config';
import { HttpProblem } from '../http/problems';

export const AGENT_PORT = 7070;

export interface ComputerSpec {
  id: string;
  workspaceId: string;
  agentToken: string;
}

export interface AgentEndpoint {
  host: string;
  port: number;
}

/** Where computers actually run. Docker in production, a fake in tests. */
export interface ComputerRuntime {
  /** Creates the container on first use, then starts it. */
  start(spec: ComputerSpec): Promise<{ containerId: string }>;
  stop(containerId: string): Promise<void>;
  /** Deletes the computer for good: its container and its home volume. */
  remove(computerId: string): Promise<void>;
  /** `null` when the container no longer exists. */
  isRunning(containerId: string): Promise<boolean | null>;
  agentEndpoint(containerId: string): Promise<AgentEndpoint>;
}

const statusOf = (error: unknown) => (error as { statusCode?: number }).statusCode;

export class DockerComputerRuntime implements ComputerRuntime {
  private readonly docker = new Docker();

  constructor(
    private readonly config: Pick<Config, 'computers' | 'workspacesDir' | 'workspacesVolume'>,
  ) {}

  static containerName(computerId: string): string {
    return `mowbot-pc-${computerId}`;
  }

  async start(spec: ComputerSpec): Promise<{ containerId: string }> {
    const name = DockerComputerRuntime.containerName(spec.id);
    let container = this.docker.getContainer(name);
    let info = await container.inspect().catch((error) => {
      if (statusOf(error) === 404) return null;
      throw error;
    });
    if (!info) {
      await this.ensureImage();
      await this.ensureNetwork();
      container = await this.docker.createContainer(this.containerOptions(name, spec));
      info = await container.inspect();
    }
    if (!info.State.Running) await container.start();
    return { containerId: info.Id };
  }

  async stop(containerId: string): Promise<void> {
    await this.docker
      .getContainer(containerId)
      .stop({ t: 10 })
      .catch((error) => {
        // 304: already stopped, 404: gone. Both mean "stopped".
        if (statusOf(error) !== 304 && statusOf(error) !== 404) throw error;
      });
  }

  async remove(computerId: string): Promise<void> {
    const name = DockerComputerRuntime.containerName(computerId);
    const gone = (error: unknown) => {
      if (statusOf(error) !== 404) throw error;
    };
    await this.docker.getContainer(name).remove({ force: true }).catch(gone);
    await this.docker.getVolume(`${name}-home`).remove().catch(gone);
  }

  async isRunning(containerId: string): Promise<boolean | null> {
    try {
      return (await this.docker.getContainer(containerId).inspect()).State.Running;
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async agentEndpoint(containerId: string): Promise<AgentEndpoint> {
    const info = await this.docker.getContainer(containerId).inspect();
    if (this.config.computers.reach === 'dns') {
      return { host: info.Name.replace(/^\//, ''), port: AGENT_PORT };
    }
    const binding = info.NetworkSettings.Ports?.[`${AGENT_PORT}/tcp`]?.[0];
    if (!binding?.HostPort) throw new Error('mow-agent port is not published');
    return { host: '127.0.0.1', port: Number(binding.HostPort) };
  }

  private async ensureImage(): Promise<void> {
    const { image } = this.config.computers;
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      throw new HttpProblem(
        503,
        'workstation_image_missing',
        `Image ${image} not found. Build it with: docker build -f workstation/Dockerfile -t ${image} .`,
      );
    }
  }

  private async ensureNetwork(): Promise<void> {
    const { network } = this.config.computers;
    const existing = await this.docker.listNetworks({ filters: { name: [network] } });
    if (existing.some((n) => n.Name === network)) return;
    await this.docker
      .createNetwork({ Name: network, Driver: 'bridge', Labels: { 'dev.mowbot': 'computers' } })
      .catch((error) => {
        if (statusOf(error) !== 409) throw error;
      });
  }

  private containerOptions(name: string, spec: ComputerSpec): Docker.ContainerCreateOptions {
    const { image, network, reach, runtime } = this.config.computers;
    const workspaceMount: Docker.MountSettings = this.config.workspacesVolume
      ? {
          Type: 'volume',
          Source: this.config.workspacesVolume,
          Target: '/workspace',
          // Docker ≥ 26 (API 1.45): mount only this workspace's folder of the shared volume.
          VolumeOptions: { Subpath: spec.workspaceId } as Docker.MountSettings['VolumeOptions'],
        }
      : {
          Type: 'bind',
          Source: path.join(this.config.workspacesDir, spec.workspaceId),
          Target: '/workspace',
        };
    return {
      name,
      Image: image,
      Hostname: `pc-${spec.id.slice(0, 8)}`,
      Labels: { 'dev.mowbot.computer': spec.id },
      Env: [`MOWBOT_AGENT_TOKEN=${spec.agentToken}`, `MOWBOT_COMPUTER_ID=${spec.id}`],
      ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
      HostConfig: {
        Mounts: [{ Type: 'volume', Source: `${name}-home`, Target: '/home/bot' }, workspaceMount],
        ShmSize: 1024 ** 3,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: network,
        Init: true,
        ...(runtime ? { Runtime: runtime } : {}),
        ...(reach === 'host-port'
          ? { PortBindings: { [`${AGENT_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] } }
          : {}),
      },
    };
  }
}
