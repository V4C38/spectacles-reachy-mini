// Looks up a six-digit PIN on the IP relay and returns the LAN address.

export const IP_RELAY_URL = "https://spectacles-ip-relay.johannestscharn.workers.dev";

export interface ResolvedPin {
    ip: string;
    port: number;
}

export class IpRelayClient {
    private readonly relayUrl: string;

    constructor(private internetModule: InternetModule, relayUrl: string = IP_RELAY_URL) {
        this.relayUrl = relayUrl.replace(/\/$/, "");
    }

    resolve(pin: string): Promise<ResolvedPin | null> {
        const request = new Request(this.relayUrl + "/v1/pins/" + pin, { method: "GET" });
        return this.internetModule.fetch(request).then((response: Response) => {
            if (response.status !== 200) {
                return null;
            }
            return response.text().then((raw: string) => {
                const body = JSON.parse(raw);
                if (!body || typeof body.ip !== "string" || typeof body.port !== "number") {
                    return null;
                }
                return { ip: body.ip, port: body.port };
            });
        }).catch(() => null);
    }
}
