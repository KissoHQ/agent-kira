import { describe, expect, it } from "vitest";

import { addressKey } from "./address-key.ts";

describe("addressKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(addressKey("192.0.2.10")).toBe("192.0.2.10");
  });

  it("counts every address of one IPv6 /64 network as one client", () => {
    const key = addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2::1")).toBe(key);
    expect(addressKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(key);
    expect(addressKey("2001:db8:1:3::1")).not.toBe(key);
  });

  it("expands the short forms of IPv6", () => {
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("counts an IPv4 address written as IPv6 as the IPv4 address", () => {
    expect(addressKey("::ffff:192.0.2.10")).toBe("192.0.2.10");
    expect(addressKey("::FFFF:c000:20a")).toBe("192.0.2.10");
  });

  it("keeps anything that is not an address as written", () => {
    expect(addressKey("unknown")).toBe("unknown");
  });
});
