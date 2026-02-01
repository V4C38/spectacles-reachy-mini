// Represents a 3D pose using position (x, y, z) in meters and orientation (roll, pitch, yaw) angles in radians
export interface XYZRPYPose {
    x: number;
    y: number;
    z: number;
    roll: number;
    pitch: number;
    yaw: number;
}

export interface MoveUUID {
    uuid: string;
}

@component
export class DaemonInterface extends BaseScriptComponent {

    @input
    public baseUrl: string = "http://192.168.1.98:8000";

    @input
    private internetModule!: InternetModule;

    onAwake() {
    }

    // HTTP fetch method
    private async fetchRequest(endpoint: string, method: string = "GET", body?: any): Promise<Response | null> {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            const requestOptions: any = {
                method: method,
                headers: {
                    "Content-Type": "application/json"
                }
            };

            if (body) {
                requestOptions.body = JSON.stringify(body);
            }

            const request = new Request(url, requestOptions);
            const response = await this.internetModule.fetch(request);
            
            // Log request details for debugging
            if (!response || response.status !== 200) {
                const status = response ? response.status : "no response";
                const bodyStr = body ? JSON.stringify(body) : "none";
                print(`DaemonInterface: Request to ${endpoint} returned ${status}. Method: ${method}, Body: ${bodyStr}`);
            }
            
            return response;
        } catch (error) {
            print(`DaemonInterface: Error making request to ${endpoint}: ${error}`);
            return null;
        }
    }

    // Check if the daemon is available and responding
    public async checkConnection(): Promise<boolean> {
        const response = await this.fetchRequest("/api/daemon/status", "GET");
        return response !== null && response.status === 200;
    }

    //Stop a running move task
    public async stopMove(moveUuid: string): Promise<void> {
        const response = await this.fetchRequest("/api/move/stop", "POST", { uuid: moveUuid });
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to stop move ${moveUuid}: HTTP ${status}`);
        }
    }

    /**
     * Request a movement to a specific target using /api/move/goto
     * @param headPose Target head pose (x, y, z in meters, roll, pitch, yaw in radians)
     * @param bodyYaw Optional target body yaw in radians
     * @param duration Duration of the movement in seconds (default: 0.5)
     * @param interpolation Interpolation mode: "linear", "minjerk", "ease", or "cartoon" (default: "minjerk")
     * @returns MoveUUID to track/stop the move
     */
    public async goto(headPose: XYZRPYPose, bodyYaw?: number, duration: number = 0.5, interpolation: string = "minjerk"): Promise<string> {
        const body: any = {
            head_pose: headPose,
            duration: duration,
            interpolation: interpolation,
            antennas: [0, 0]
        };
        if (bodyYaw !== undefined) {
            body.body_yaw = bodyYaw;
        }
        const response = await this.fetchRequest("/api/move/goto", "POST", body);
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to execute goto movement: HTTP ${status}`);
        }
        const data = await response.json() as MoveUUID;
        return data.uuid;
    }

    /**
     * Set target pose immediately (no interpolation) using /api/move/set_target
     * Used for real-time tracking at high frequency (e.g., 50Hz)
     * @param headPose Target head pose (x, y, z in meters, roll, pitch, yaw in radians)
     * @param bodyYaw Optional target body yaw in radians
     * @param antennas Optional antenna positions [left, right] in radians
     */
    public async setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void> {
        const body: any = {
            target_head_pose: headPose,
            target_antennas: antennas ?? [0, 0]
        };
        if (bodyYaw !== undefined) {
            body.target_body_yaw = bodyYaw;
        }
        const response = await this.fetchRequest("/api/move/set_target", "POST", body);
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to set_target: HTTP ${status}`);
        }
    }
}
