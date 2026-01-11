/**
 * Represents a 3D pose using position (x, y, z) in meters and orientation (roll, pitch, yaw) angles in radians.
 */
export interface XYZRPYPose {
    x: number;
    y: number;
    z: number;
    roll: number;
    pitch: number;
    yaw: number;
}

/**
 * Represents a unique identifier for a move task.
 */
export interface MoveUUID {
    uuid: string;
}

@component
export class DaemonInterface extends BaseScriptComponent {
    private static _instance: DaemonInterface | null = null;

    @input
    @hint("Base URL for the Reachy Mini daemon (e.g., http://192.168.1.108:8000)")
    private baseUrl: string = "http://192.168.1.108:8000";

    @input
    @hint("InternetModule asset for making HTTP requests")
    private internetModule!: InternetModule;

    onAwake() {
        // Set this instance as the singleton
        DaemonInterface._instance = this;
    }

    /**
     * Get the singleton instance of DaemonInterface
     */
    public static getInstance(): DaemonInterface | null {
        return DaemonInterface._instance;
    }

    /**
     * Internal HTTP fetch method
     */
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

    /**
     * Move a joint to a specific position
     * @param jointName Name of the joint to move
     * @param position Target position (angle in degrees or position value)
     */
    public async moveJoint(jointName: string, position: number): Promise<void> {
        const response = await this.fetchRequest(`/api/arm/${jointName}/move`, "POST", { position });
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to move joint ${jointName}: HTTP ${status}`);
        }
    }

    /**
     * Play an audio file on the robot
     * @param audioFile Path or name of the audio file to play
     */
    public async playAudio(audioFile: string): Promise<void> {
        const response = await this.fetchRequest("/api/audio/play", "POST", { file: audioFile });
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to play audio ${audioFile}: HTTP ${status}`);
        }
    }

    /**
     * Check if the daemon is available and responding
     * @returns true if connection is successful, false otherwise
     */
    public async checkConnection(): Promise<boolean> {
        const response = await this.fetchRequest("/api/health", "GET");
        return response !== null && response.status === 200;
    }

    /**
     * List available recorded moves in a dataset
     * @param datasetName Name of the dataset to query (may contain slashes, will be URL-encoded)
     * @returns Array of move names available in the dataset
     */
    public async listRecordedMoves(datasetName: string): Promise<string[]> {
        // URL-encode the dataset name to handle slashes and special characters
        const encodedDatasetName = encodeURIComponent(datasetName);
        const response = await this.fetchRequest(`/api/move/recorded-move-datasets/list/${encodedDatasetName}`, "GET");
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to list recorded moves for dataset ${datasetName}: HTTP ${status}`);
        }
        const data = await response.json();
        return data as string[];
    }

    /**
     * Play a recorded move from a dataset
     * @param datasetName Name of the dataset containing the move (will be URL-encoded)
     * @param moveName Name of the move to play (will be URL-encoded)
     * @returns MoveUUID to track/stop the move
     */
    public async playRecordedMove(datasetName: string, moveName: string): Promise<string> {
        // URL-encode both dataset name and move name (e.g., '/' becomes '%2F')
        const encodedDatasetName = encodeURIComponent(datasetName);
        const encodedMoveName = encodeURIComponent(moveName);
        const endpoint = `/api/move/play/recorded-move-dataset/${encodedDatasetName}/${encodedMoveName}`;
        const response = await this.fetchRequest(endpoint, "POST");
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            const url = `${this.baseUrl}${endpoint}`;
            throw new Error(`Failed to play recorded move ${moveName} from dataset ${datasetName}: HTTP ${status} (URL: ${url})`);
        }
        const data = await response.json() as MoveUUID;
        return data.uuid;
    }

    /**
     * Stop a running move task
     * @param moveUuid UUID of the move to stop
     */
    public async stopMove(moveUuid: string): Promise<void> {
        const response = await this.fetchRequest("/api/move/stop", "POST", { uuid: moveUuid });
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to stop move ${moveUuid}: HTTP ${status}`);
        }
    }

    /**
     * Get list of currently running move tasks
     * @returns Array of MoveUUID for running moves
     */
    public async getRunningMoves(): Promise<MoveUUID[]> {
        const response = await this.fetchRequest("/api/move/running", "GET");
        if (!response || response.status !== 200) {
            const status = response ? response.status : "no response";
            throw new Error(`Failed to get running moves: HTTP ${status}`);
        }
        const data = await response.json();
        return data as MoveUUID[];
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
