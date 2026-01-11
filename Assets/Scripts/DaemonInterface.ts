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
}
