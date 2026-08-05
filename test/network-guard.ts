import net from "node:net";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const originalConnect = net.Socket.prototype.connect;
const originalCreateConnection = net.createConnection;

function requestedHost(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (Array.isArray(first)) {
    return requestedHost(first);
  }
  if (typeof first === "object" && first !== null && "host" in first) {
    const host = Reflect.get(first, "host");
    return typeof host === "string" ? host : undefined;
  }
  if (typeof first === "number" && typeof args[1] === "string") {
    return args[1];
  }
  return undefined;
}

net.Socket.prototype.connect = function guardedConnect(...args: unknown[]): net.Socket {
  const host = requestedHost(args);
  if (host !== undefined && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`Network access is disabled in tests: ${host}`);
  }
  return Reflect.apply(originalConnect, this, args) as net.Socket;
} as typeof net.Socket.prototype.connect;

net.createConnection = function guardedCreateConnection(...args: unknown[]): net.Socket {
  const host = requestedHost(args);
  if (host !== undefined && !LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`Network access is disabled in tests: ${host}`);
  }
  return Reflect.apply(originalCreateConnection, net, args) as net.Socket;
} as typeof net.createConnection;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}
