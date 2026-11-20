import { isIP } from "node:net";

// One person on IPv6 usually holds a whole /64 network, 2^64 addresses: a limit counted per full
// address would give them as many tries as they want. The limits therefore count an IPv6 client by
// its /64 network, and an IPv4 address written as IPv6 (::ffff:192.0.2.1) as the IPv4 address it
// is. Anything else, such as "unknown", is counted as written.
const ipv6Groups = 8;
const networkGroups = 4;

export function addressKey(address: string): string {
  const trimmed = address.trim().toLowerCase();
  // A zone, such as fe80::1%eth0, names the interface of this machine, not the client.
  const withoutZone = trimmed.split("%")[0] ?? trimmed;
  if (isIP(withoutZone) !== 6) {
    return trimmed;
  }
  const groups = expandIpv6(withoutZone);
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  const network = groups.slice(0, networkGroups).map((group) => group.toString(16));
  return `${network.join(":")}::/64`;
}

// The 16-bit groups of one side of "::". A trailing IPv4 part, as in 64:ff9b::192.0.2.1, gives
// two groups.
function toGroups(part: string): number[] {
  if (part === "") {
    return [];
  }
  return part.split(":").flatMap((group) => {
    if (group.includes(".")) {
      const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
      return [(a << 8) | b, (c << 8) | d];
    }
    return [Number.parseInt(group, 16)];
  });
}

// The eight 16-bit groups of a valid IPv6 address, with "::" filled in.
function expandIpv6(address: string): number[] {
  const [head = "", tail] = address.split("::");
  const first = toGroups(head);
  if (tail === undefined) {
    return first;
  }
  const last = toGroups(tail);
  const zeros = Array.from({ length: ipv6Groups - first.length - last.length }, () => 0);
  return [...first, ...zeros, ...last];
}
