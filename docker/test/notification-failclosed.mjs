// F-QA6-00 fail-closed guard. Runs INSIDE the worker container before the worker
// starts (and once more from run-notifications-test.sh), so no email can leave
// before it passes. The Gmail host is hard-coded (smtp.gmail.com:465), so a test
// is only safe when that name resolves, through DNS as nodemailer resolves it, to
// the fake SMTP server and the container has no route to the internet.
// Exit 0 only if:
//   - dns.resolve4 and getaddrinfo (dns.lookup) both give smtp.gmail.com exactly
//     the fake's addresses (FAKE_SMTP_SERVICE, default "mailpit");
//   - /etc/hosts does not mention smtp.gmail.com (extra_hosts is not enough);
//   - TCP to 1.1.1.1:443 and [2606:4700:4700::1111]:443 does not connect.
import { lookup, resolve4 } from "node:dns/promises"
import { readFile } from "node:fs/promises"
import net from "node:net"

const HOST = "smtp.gmail.com"
const FAKE = process.env.FAKE_SMTP_SERVICE || "mailpit"
let ok = true
const report = (check, pass, detail = {}) => {
  if (!pass) ok = false
  process.stdout.write(JSON.stringify({ failclosed: check, ok: pass, ...detail }) + "\n")
}
const sorted = (list) => [...new Set(list)].sort()
const safe = async (fn) => {
  try {
    return await fn()
  } catch (error) {
    return { error: error.code ?? String(error) }
  }
}

const fake = await safe(async () => sorted((await lookup(FAKE, { all: true })).map((a) => a.address)))
report("fake_smtp_resolves", Array.isArray(fake) && fake.length > 0, { service: FAKE, addresses: fake })

const viaDns = await safe(async () => sorted(await resolve4(HOST)))
report("dns_resolve4_is_fake", Array.isArray(viaDns) && Array.isArray(fake) && viaDns.join() === fake.join(), { host: HOST, addresses: viaDns })

const viaLookup = await safe(async () => sorted((await lookup(HOST, { all: true })).map((a) => a.address)))
report("getaddrinfo_is_fake", Array.isArray(viaLookup) && Array.isArray(fake) && viaLookup.join() === fake.join(), { host: HOST, addresses: viaLookup })

const hosts = await readFile("/etc/hosts", "utf8").catch(() => "")
report("no_etc_hosts_entry", !hosts.includes(HOST))

function probe(host) {
  return new Promise((done) => {
    const socket = net.connect({ host, port: 443 })
    const finish = (result) => {
      socket.destroy()
      done(result)
    }
    socket.setTimeout(5_000, () => finish("BLOCKED timeout"))
    socket.on("connect", () => finish("OPEN"))
    socket.on("error", (error) => finish(`BLOCKED ${error.code ?? "error"}`))
  })
}
for (const ip of ["1.1.1.1", "2606:4700:4700::1111"]) {
  const result = await probe(ip)
  report(`no_route_${ip}:443`, result.startsWith("BLOCKED"), { result })
}

process.stdout.write(`FAILCLOSED_OK=${ok ? 1 : 0}\n`)
process.exit(ok ? 0 : 1)
