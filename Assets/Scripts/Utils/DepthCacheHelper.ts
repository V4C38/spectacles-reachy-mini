interface CapturedDepthFrame {
    depthFrame: Float32Array;
    depthDeviceCamera: DeviceCamera;
    depthCameraPose: mat4;
    timestamp: number;
}

@component
export class DepthCacheHelper extends BaseScriptComponent {
    
    private depthModule: DepthModule = require("LensStudio:DepthModule");
    private depthFrameSession: DepthFrameSession;
    private colorDeviceCamera: DeviceCamera;
    
    // Single captured depth frame (set when captureFrame() is called)
    private capturedFrame: CapturedDepthFrame | null = null;
    private latestFrame: CapturedDepthFrame | null = null;
    
    // Configuration
    private readonly MEDIAN_RADIUS = 1;  // 3x3 sampling window

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.initialize();
        });
        
        this.createEvent("OnDestroyEvent").bind(() => {
            this.cleanup();
        });
    }

    private initialize(): void {
        this.colorDeviceCamera = global.deviceInfoSystem.getTrackingCameraForId(
            CameraModule.CameraId.Left_Color
        );
        
        this.depthFrameSession = this.depthModule.createDepthFrameSession();
        this.depthFrameSession.onNewFrame.add((depthFrameData: DepthFrameData) => {
            this.updateLatestFrame(depthFrameData);
        });
        this.depthFrameSession.start();
    }

    private updateLatestFrame(depthFrameData: DepthFrameData): void {
        this.latestFrame = {
            depthFrame: depthFrameData.depthFrame.slice(),
            depthDeviceCamera: depthFrameData.deviceCamera,
            depthCameraPose: mat4.fromColumns(
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column0,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column1,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column2,
                depthFrameData.toWorldTrackingOriginFromDeviceRef.column3
            ),
            timestamp: depthFrameData.timestampSeconds
        };
    }

    public captureFrame(): void {
        if (!this.latestFrame) {
            throw new Error("DepthCacheHelper: No depth frames available");
        }
        // Store a snapshot of the latest frame for the current detection
        this.capturedFrame = this.latestFrame;
    }

    /**
     * Convert normalized 2D color image coordinates to 3D world position
     * Uses the single captured frame from captureFrame()
     * 
     * @param normalizedX - X coordinate (0-1) on the color image
     * @param normalizedY - Y coordinate (0-1) on the color image
     * @returns World position or null if depth unavailable
     */
    public getWorldPosition(normalizedX: number, normalizedY: number): vec3 | null {
        if (!this.capturedFrame) {
            return null;
        }
        
        // Remap from color frame to depth frame
        const normalizedPointOnColorFrame = new vec2(normalizedX, normalizedY);
        
        // Unproject to 3D using color camera (arbitrary depth of 100 for direction only)
        const pointInCameraSpace = this.colorDeviceCamera.unproject(normalizedPointOnColorFrame, 100.0);
        
        // Project onto depth camera frame
        const normalizedPointOnDepthFrame = this.capturedFrame.depthDeviceCamera.project(pointInCameraSpace);
        
        // Check if point is within depth frame bounds
        if (!this.isNormalizedPointInBounds(normalizedPointOnDepthFrame)) {
            return null;
        }
        
        // Convert to pixel coordinates on depth frame
        const depthRes = this.capturedFrame.depthDeviceCamera.resolution;
        const pixelX = Math.floor(normalizedPointOnDepthFrame.x * depthRes.x);
        const pixelY = Math.floor(normalizedPointOnDepthFrame.y * depthRes.y);
        
        // Sample depth with median filter for robustness
        const depthValue = this.getMedianDepth(
            this.capturedFrame.depthFrame,
            depthRes.x,
            depthRes.y,
            pixelX,
            pixelY,
            this.MEDIAN_RADIUS
        );
        
        if (depthValue === null || depthValue <= 0) {
            return null;
        }
        
        // Unproject from depth camera to device reference space
        const pointInDeviceRef = this.capturedFrame.depthDeviceCamera.unproject(normalizedPointOnDepthFrame, depthValue);
        
        // Transform to world space
        return this.capturedFrame.depthCameraPose.multiplyPoint(pointInDeviceRef);
    }

    /**
     * Get median depth value in a window around the target pixel
     */
    private getMedianDepth(
        depthData: Float32Array,
        width: number,
        height: number,
        x: number,
        y: number,
        radius: number
    ): number | null {
        const samples: number[] = [];
        
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const val = depthData[nx + ny * width];
                    if (val > 0) samples.push(val);
                }
            }
        }
        
        if (samples.length === 0) return null;
        
        samples.sort((a, b) => a - b);
        const mid = Math.floor(samples.length / 2);
        return samples.length % 2 === 0 
            ? (samples[mid - 1] + samples[mid]) / 2 
            : samples[mid];
    }

    private isNormalizedPointInBounds(point: vec2): boolean {
        return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
    }

    /**
     * Get the world-space position at the center of the current camera view.
     * @returns World position at the center of the view, or null if depth unavailable
     */
    public getForwardIntersection(): vec3 | null {
        if (!this.latestFrame) {
            return null;
        }

        // Center of the color image
        const normalizedCenter = new vec2(0.5, 0.5);

        // Unproject to 3D using color camera (arbitrary depth for direction only)
        const pointInCameraSpace = this.colorDeviceCamera.unproject(normalizedCenter, 100.0);

        // Project onto depth camera frame
        const normalizedPointOnDepthFrame = this.latestFrame.depthDeviceCamera.project(pointInCameraSpace);

        if (!this.isNormalizedPointInBounds(normalizedPointOnDepthFrame)) {
            return null;
        }

        const depthRes = this.latestFrame.depthDeviceCamera.resolution;
        const pixelX = Math.floor(normalizedPointOnDepthFrame.x * depthRes.x);
        const pixelY = Math.floor(normalizedPointOnDepthFrame.y * depthRes.y);

        const depthValue = this.getMedianDepth(
            this.latestFrame.depthFrame,
            depthRes.x,
            depthRes.y,
            pixelX,
            pixelY,
            this.MEDIAN_RADIUS
        );

        if (depthValue === null || depthValue <= 0) {
            return null;
        }

        const pointInDeviceRef = this.latestFrame.depthDeviceCamera.unproject(normalizedPointOnDepthFrame, depthValue);
        return this.latestFrame.depthCameraPose.multiplyPoint(pointInDeviceRef);
    }

    public hasDepthData(): boolean {
        return this.latestFrame !== null;
    }

    public cleanup(): void {
        if (this.depthFrameSession) {
            this.depthFrameSession.stop();
        }
        this.capturedFrame = null;
        this.latestFrame = null;
    }
}
