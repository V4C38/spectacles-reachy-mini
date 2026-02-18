import { AnchorModule } from "Spatial Anchors.lspkg/AnchorModule";
import { AnchorSession, AnchorSessionOptions } from "Spatial Anchors.lspkg/AnchorSession";
import { Anchor } from "Spatial Anchors.lspkg/Anchor";
import { WorldAnchor } from "Spatial Anchors.lspkg/WorldAnchor";

@component
export class PersistenceManager extends BaseScriptComponent {

    @input anchorModule: AnchorModule;

    private readonly IP_KEY = "reachy_mini_ip";
    private readonly ANCHOR_AREA = "reachy_mini_position";

    private anchorSession: AnchorSession | null = null;
    private currentAnchor: WorldAnchor | null = null;

    private get store(): GeneralDataStore {
        return global.persistentStorageSystem.store;
    }

    // ------------------------------------------------------------
    // IP Storage
    // ------------------------------------------------------------
    public saveIp(ip: string): void {
        this.store.putString(this.IP_KEY, ip);
    }

    public loadIp(): string | null {
        if (this.store.has(this.IP_KEY)) {
            return this.store.getString(this.IP_KEY);
        }
        return null;
    }

    // ------------------------------------------------------------
    // Anchor - Simple API
    // ------------------------------------------------------------
    
    public async loadAnchorPosition(): Promise<vec3 | null> {
        // Close any existing session first
        if (this.anchorSession) {
            await this.anchorSession.close();
            this.anchorSession = null;
            this.currentAnchor = null;
        }

        if (!this.anchorModule) {
            return null;
        }

        const options = new AnchorSessionOptions();
        options.scanForWorldAnchors = true;
        options.area = this.ANCHOR_AREA;

        this.anchorSession = await this.anchorModule.openSession(options);

        // Wait for anchor to be found (with timeout)
        return new Promise<vec3 | null>((resolve) => {
            let found = false;

            this.anchorSession.onAnchorNearby.add((anchor: Anchor) => {
                this.currentAnchor = anchor as WorldAnchor;
                
                anchor.onFound.add(() => {
                    if (!found) {
                        found = true;
                        const pos = anchor.toWorldFromAnchor.column3;
                        resolve(new vec3(pos.x, pos.y, pos.z));
                    }
                });
            });

            // Timeout after 2 seconds
            const delayedEvent = this.createEvent("DelayedCallbackEvent");
            delayedEvent.bind(() => {
                if (!found) {
                    resolve(null);
                }
            });
            delayedEvent.reset(1.5);
        });
    }

    public async saveAnchorPosition(position: vec3): Promise<void> {
        if (!this.anchorSession) {
            if (!this.anchorModule) {
                return;
            }
            const options = new AnchorSessionOptions();
            options.scanForWorldAnchors = false;
            options.area = this.ANCHOR_AREA;
            this.anchorSession = await this.anchorModule.openSession(options);
        }

        const transform = mat4.fromTranslation(position);

        if (this.currentAnchor) {
            this.currentAnchor.toWorldFromAnchor = transform;
        } else {
            this.currentAnchor = await this.anchorSession.createWorldAnchor(transform);
        }

        await this.anchorSession.saveAnchor(this.currentAnchor);
    }
}
