import path from 'node:path';
import type { ComputerGpus, ComputerKind, ComputerSystem, Gpu, GpuList } from '@mowbot/contract';
import Docker from 'dockerode';
import type { Config } from '../config';
import { HttpProblem } from '../http/problems';

export const AGENT_PORT = 7070;

export interface ComputerSpec {
  id: string;
  /** `mcp`: the MCP computer, from its own image (no desktop). */
  kind: ComputerKind;
  /** With its desktop, or only a shell (no screen). */
  system: ComputerSystem;
  /** The host's graphics cards it gets (null: none). */
  gpus: ComputerGpus | null;
  workspaceId: string;
  agentToken: string;
}

/** What a container is made with beyond its image: another setup makes a new container. */
export function setupKey(spec: Pick<ComputerSpec, 'system' | 'gpus'>): string {
  const gpus = spec.gpus === 'all' ? 'all' : spec.gpus ? [...spec.gpus].sort().join(',') : '';
  return `${spec.system};${gpus}`;
}

/** A GPU list from `nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits`. */
export function parseGpus(csv: string): Gpu[] {
  return csv
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [index, id, name, memory] = line.split(',').map((cell) => cell.trim());
      if (!id?.startsWith('GPU-') || !name) return [];
      const memoryMb = Number.parseInt(memory ?? '', 10);
      return [
        {
          id,
          index: Number.parseInt(index ?? '0', 10) || 0,
          name,
          memoryMb: Number.isFinite(memoryMb) ? memoryMb : null,
        },
      ];
    });
}

export interface AgentEndpoint {
  host: string;
  port: number;
}

/** Where computers actually run. Docker in production, a fake in tests. */
export interface ComputerRuntime {
  /**
   * Creates the container on first use, then starts it. `setup`: what the container was made
   * with (`setupKey`), the asked one unless it was already running.
   */
  start(spec: ComputerSpec): Promise<{ containerId: string; setup: string }>;
  stop(containerId: string): Promise<void>;
  /** Deletes the computer for good: its container and its home volume. */
  remove(computerId: string): Promise<void>;
  /** `null` when the container no longer exists. */
  isRunning(containerId: string): Promise<boolean | null>;
  agentEndpoint(containerId: string): Promise<AgentEndpoint>;
  /** The host's graphics cards that containers can get. */
  gpus(): Promise<GpuList>;
}

/** Docker's request for the cards a PC gets (NVIDIA Container Toolkit). */
function deviceRequests(gpus: ComputerGpus | null): Docker.DeviceRequest[] {
  if (!gpus) return [];
  return [
    gpus === 'all'
      ? { Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }
      : { Driver: 'nvidia', DeviceIDs: gpus, Capabilities: [['gpu']] },
  ];
}

/** How long the list of cards is kept: they rarely change. */
const GPU_LIST_TTL_MS = 10 * 60_000;

const statusOf = (error: unknown) => (error as { statusCode?: number }).statusCode;

/** Containers made before PCs had a setup ran this one. */
const DEFAULT_SETUP = { system: 'desktop', gpus: null } as const;

export class DockerComputerRuntime implements ComputerRuntime {
  private readonly docker = new Docker();
  private gpuList: { at: number; list: Promise<GpuList> } | null = null;

  constructor(
    private readonly config: Pick<Config, 'computers' | 'workspacesDir' | 'workspacesVolume'>,
  ) {}

  static containerName(computerId: string): string {
    return `mowbot-pc-${computerId}`;
  }

  async start(spec: ComputerSpec): Promise<{ containerId: string; setup: string }> {
    const name = DockerComputerRuntime.containerName(spec.id);
    let container = this.docker.getContainer(name);
    let info = await container.inspect().catch((error) => {
      if (statusOf(error) === 404) return null;
      throw error;
    });
    // A stopped computer built from an older image, or with another setup (system, cards), is
    // recreated: its home (installs, browser profile) and its workspace are volumes and stay.
    if (info && !info.State.Running) {
      const current = await this.docker
        .getImage(this.imageOf(spec.kind))
        .inspect()
        .catch(() => null);
      const setup = info.Config.Labels?.['dev.mowbot.setup'] ?? setupKey(DEFAULT_SETUP);
      if ((current && current.Id !== info.Image) || setup !== setupKey(spec)) {
        await container.remove({ force: true });
        info = null;
      }
    }
    if (!info) {
      await this.ensureImage(spec.kind);
      await this.ensureNetwork();
      container = await this.docker.createContainer(this.containerOptions(name, spec));
      info = await container.inspect();
    }
    if (!info.State.Running) await container.start();
    return {
      containerId: info.Id,
      setup: info.Config.Labels?.['dev.mowbot.setup'] ?? setupKey(DEFAULT_SETUP),
    };
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

  async gpus(): Promise<GpuList> {
    if (this.gpuList && Date.now() - this.gpuList.at < GPU_LIST_TTL_MS) return this.gpuList.list;
    const list = this.queryGpus();
    this.gpuList = { at: Date.now(), list };
    return list;
  }

  /**
   * Asks the cards of a throwaway container given all of them (nvidia-smi comes with the
   * toolkit): no toolkit or no card, none.
   */
  private async queryGpus(): Promise<GpuList> {
    const none: GpuList = { available: false, items: [] };
    try {
      const info = await this.docker.info();
      const runtimes = Object.keys((info as { Runtimes?: Record<string, unknown> }).Runtimes ?? {});
      if (!runtimes.includes('nvidia')) return none;
      const image = this.imageOf('team');
      await this.docker.getImage(image).inspect();
      const container = await this.docker.createContainer({
        Image: image,
        Entrypoint: ['nvidia-smi'],
        Cmd: ['--query-gpu=index,uuid,name,memory.total', '--format=csv,noheader,nounits'],
        // With a terminal, its output comes back as plain text (no stream frames).
        Tty: true,
        Labels: { 'dev.mowbot': 'gpu-query' },
        HostConfig: { DeviceRequests: deviceRequests('all'), NetworkMode: 'none' },
      });
      try {
        await container.start();
        const { StatusCode } = await container.wait();
        const text = (await container.logs({ stdout: true })).toString('utf8');
        if (StatusCode !== 0) return none;
        const items = parseGpus(text);
        return { available: items.length > 0, items };
      } finally {
        await container.remove({ force: true }).catch(() => {});
      }
    } catch {
      return none;
    }
  }

  private imageOf(kind: ComputerKind): string {
    return kind === 'mcp' ? this.config.computers.mcpImage : this.config.computers.image;
  }

  private async ensureImage(kind: ComputerKind): Promise<void> {
    const image = this.imageOf(kind);
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      const dockerfile = kind === 'mcp' ? 'workstation/mcp.Dockerfile' : 'workstation/Dockerfile';
      throw new HttpProblem(
        503,
        'workstation_image_missing',
        `Image ${image} not found. Build it with: docker build -f ${dockerfile} -t ${image} .`,
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
    const { network, reach, runtime } = this.config.computers;
    const mcp = spec.kind === 'mcp';
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
      Image: this.imageOf(spec.kind),
      Hostname: mcp ? 'mcp' : `pc-${spec.id.slice(0, 8)}`,
      Labels: {
        'dev.mowbot.computer': spec.id,
        'dev.mowbot.kind': spec.kind,
        'dev.mowbot.setup': setupKey(spec),
      },
      // Only what mow-agent needs: never the hub's own secrets.
      Env: [
        `MOWBOT_AGENT_TOKEN=${spec.agentToken}`,
        `MOWBOT_COMPUTER_ID=${spec.id}`,
        // No screen: no X server, no desktop, a browser without a window.
        ...(spec.system === 'terminal' ? ['MOWBOT_DESKTOP=0'] : []),
        // Every driver part: compute (CUDA), video (NVENC), graphics (OpenGL, Vulkan).
        ...(spec.gpus ? ['NVIDIA_DRIVER_CAPABILITIES=all'] : []),
      ],
      ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
      HostConfig: {
        // The home keeps installs, caches and the servers' own config and tokens.
        Mounts: [{ Type: 'volume', Source: `${name}-home`, Target: '/home/bot' }, workspaceMount],
        // Chrome needs a large /dev/shm; the MCP computer has no browser.
        ...(mcp ? {} : { ShmSize: 1024 ** 3 }),
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: network,
        Init: true,
        ...(runtime ? { Runtime: runtime } : {}),
        ...(spec.gpus ? { DeviceRequests: deviceRequests(spec.gpus) } : {}),
        ...(reach === 'host-port'
          ? { PortBindings: { [`${AGENT_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] } }
          : {}),
      },
    };
  }
}
