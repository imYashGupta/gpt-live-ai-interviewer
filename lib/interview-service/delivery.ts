import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/** Conservative IPv4-only transport. Reject private, loopback, link-local, reserved and multicast ranges. */
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || a===100 && b>=64 && b<=127 || a===169 && b===254
    || a===172 && b>=16 && b<=31 || a===192 && (b===168 || b===0 || b===2 || b===88 && c===99)
    || a===198 && (b===18 || b===19 || b===51 && c===100) || a===203 && b===0 && c===113);
}
export function webhookUrl(urlString: string, production = process.env.NODE_ENV === "production") {
  const url = new URL(urlString);
  const addressKind = isIP(url.hostname);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.hash
    || addressKind && addressKind !== 4
    || production && (url.protocol !== "https:" || url.port && url.port !== "443" || addressKind)) throw new Error("Destination not allowed");
  return url;
}
export async function destination(urlString: string, allowedHosts: string[], production = process.env.NODE_ENV === "production") {
  const url = webhookUrl(urlString,production);
  const addressKind = isIP(url.hostname);
  if (!allowedHosts.includes(url.hostname)) throw new Error("Destination not allowed");
  const addresses = addressKind === 4 ? [{address:url.hostname}] : await lookup(url.hostname,{family:4,all:true});
  if (!addresses.length || production && addresses.some(a => !isPublicIPv4(a.address))) throw new Error("Destination is not public IPv4");
  return { url, address: addresses[0].address };
}
export type WebhookTransport = (url: string, body: string, headers: Record<string,string>) => Promise<void>;
export function webhookTransport(allowedHosts: string[], production = process.env.NODE_ENV === "production"): WebhookTransport {
  return async (urlString,body,headers) => {
    const { url,address } = await destination(urlString,allowedHosts,production);
    await new Promise<void>((resolve,reject) => {
      // Pin this request to the validated DNS answer while preserving TLS hostname verification when HTTPS is used.
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url,{method:"POST",headers:{...headers,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body).toString()},
        agent:false, family:4, lookup: (_hostname,_options,callback) => callback(null,address,4)},res => {
        const ok = res.statusCode && res.statusCode>=200 && res.statusCode<300;
        res.destroy(); // No response payload is needed; redirects are never followed.
        if (ok) resolve(); else reject(new Error("Webhook rejected"));
      });
      const timer = setTimeout(() => req.destroy(new Error("Webhook timed out")),5000);
      req.on("close",() => clearTimeout(timer)); req.on("error",reject); req.end(body);
    });
  };
}
