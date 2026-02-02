import { AnchorModule } from "Spatial Anchors.lspkg/AnchorModule";
import { AnchorSession, AnchorSessionOptions } from "Spatial Anchors.lspkg/AnchorSession";
import { Anchor } from "Spatial Anchors.lspkg/Anchor";
import { WorldAnchor } from "Spatial Anchors.lspkg/WorldAnchor";

@component
export class PersistenceManager extends BaseScriptComponent {

    @input anchorModule: AnchorModule;

    // Storage keys
    private readonly IP_KEY = "reachy_mini_ip";
    private readonly ANCHOR_AREA = "reachy_mini_position";

    // Anchor state
    private anchorSession: AnchorSession | null = null;
    private currentAnchor: WorldAnchor | null = null;

    // Callbacks
    public onPositionRestored: ((position: vec3, rotation: quat) => void) | null = null;


    private get store(): GeneralDataStore {
        return global.persistentStorageSystem.store;
    }

    onAwake() {}

    // ------------------------------------------------------------
    // Persistent Storage
    // Used to save and restore the IP of the machine running the daemon
    // ------------------------------------------------------------
    public saveIp(ip: string): void {
        this.store.putString(this.IP_KEY, ip);
        print(`PersistenceManager: IP saved: ${ip}`);
    }

    public loadIp(): string | null {
        if (this.store.has(this.IP_KEY)) {
            const ip = this.store.getString(this.IP_KEY);
            print(`PersistenceManager: IP loaded: ${ip}`);
            return ip;
        }
        return null;
    }

    public hasStoredIp(): boolean {
        return this.store.has(this.IP_KEY);
    }

    // ------------------------------------------------------------
    // Spatial Anchors
    // Used to save and restore the position of the Reachy Mini
    // ------------------------------------------------------------
    public async initializeAnchors(): Promise<void> {
        if (!this.anchorModule) {
            throw new Error("PersistenceManager: AnchorModule not assigned");
        }

        const options = new AnchorSessionOptions();
        options.scanForWorldAnchors = true;
        options.area = this.ANCHOR_AREA;

        this.anchorSession = await this.anchorModule.openSession(options);
        this.anchorSession.onAnchorNearby.add(this.onAnchorNearby.bind(this));
        
        print("PersistenceManager: Anchor session initialized");
    }

    private onAnchorNearby(anchor: Anchor): void {
        print(`PersistenceManager: Anchor found: ${anchor.id}`);
        
        // Wait for anchor to be ready/found
        anchor.onFound.add(() => {
            const transform = anchor.toWorldFromAnchor;
            // Extract position from mat4 by transforming the origin
            const position = transform.multiplyPoint(vec3.zero());
            // Extract rotation by transforming unit vectors and computing rotation
            const forward = transform.multiplyDirection(vec3.forward());
            const up = transform.multiplyDirection(vec3.up());
            const rotation = quat.lookAt(forward, up);
            
            print(`PersistenceManager: Position restored: ${position}`);
            
            if (this.onPositionRestored) {
                this.onPositionRestored(position, rotation);
            }
        });
    }

    public async savePosition(position: vec3, rotation: quat): Promise<void> {
        if (!this.anchorSession) {
            throw new Error("PersistenceManager: Anchor session not initialized");
        }

        // Delete existing anchor if any
        if (this.currentAnchor) {
            try {
                await this.anchorSession.deleteAnchor(this.currentAnchor);
                print("PersistenceManager: Previous anchor deleted");
            } catch (e) {
                print(`PersistenceManager: Error deleting anchor: ${e}`);
            }
        }

        // Create transform matrix from position and rotation
        const transform = mat4.compose(position, rotation, vec3.one());

        // Create and save new anchor
        this.currentAnchor = await this.anchorSession.createWorldAnchor(transform);
        await this.anchorSession.saveAnchor(this.currentAnchor);
        
        print(`PersistenceManager: Position saved at ${position}`);
    }

    public hasStoredPosition(): boolean {
        return this.currentAnchor !== null;
    }
}
