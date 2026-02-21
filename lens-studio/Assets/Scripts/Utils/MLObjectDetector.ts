import { DepthCache } from "./DepthCache";
import { getInteractableLookAt } from "./InteractableLookAt";
import { ReachyMiniManager } from "../ReachyMiniManager";
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/Gemini";
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GeminiTypes";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";


export interface DetectedObject {
    id: string;                 // Unique identifier
    name: string;               // Object class name
    position: vec3;             // World position
    confidence: number;         // Detection confidence (0-1)
    lastSeen: number;           // Timestamp of last detection
    markerObject: SceneObject;  // Reference to spawned marker
}

export interface DetectionItem {
    name: string;
    x: number;
    y: number;
    confidence: number;
}

export interface GeminiDetectionResult {
    objects: DetectionItem[];
}


@component
export class MLObjectDetector extends BaseScriptComponent {
    
    @input
    private depthCacheHelper: DepthCache;

    @input
    private objectMarkerPrefab: ObjectPrefab;

    @input
    private worldMeshRenderer: RenderMeshVisual;

    @input
    private worldMeshRoot: SceneObject | null = null;

    @input
    public reachyMiniManager: ReachyMiniManager | null = null;

    private cameraModule: CameraModule = require("LensStudio:CameraModule");

    // --- State ---
    private detectedObjects: Map<string, DetectedObject> = new Map();
    private currentMarkers: SceneObject[] = [];
    private isProcessing: boolean = false;
        
    // --- Configuration ---
    private readonly CONFIDENCE_THRESHOLD = 0.35;
    private readonly REACHY_EXCLUSION_RADIUS_M = 0.25; 

    // --- World-mesh animation state ---
    private worldMeshVisible: boolean = false;
    private currentOpacity: number = 0;
    private readonly WM_FADE_IN_DURATION = 1.8;
    private readonly WM_FADE_OUT_DURATION = 1.2;
    private readonly WM_PULSE_DURATION = 3.0;
    private readonly WM_PULSE_MIN_OPACITY = 0.5;

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.waitForDepthReady();
        });
    }

    private waitForDepthReady(): void {
        const checkEvent = this.createEvent("UpdateEvent");
        checkEvent.bind(() => {
            if (this.depthCacheHelper && this.depthCacheHelper.hasDepthData()) {
                checkEvent.enabled = false;
            }
        });
    }

    public getIsProcessing(): boolean {
        return this.isProcessing;
    }

    // ----------------------------------------------------------------
    // Object Detection
    // ----------------------------------------------------------------
    public clearAllDetections(): void {
        const staleMarkers = this.currentMarkers;
        for (const marker of staleMarkers) {
            if (!isNull(marker)) {
                marker.destroy();
            }
        }
        this.currentMarkers = [];
        this.detectedObjects.clear();
    }

    /**
     * Main entry point for object detection
     * @param prompt - The prompt to send to Gemini describing what objects to find
     * @param markerPrefab - The prefab to instantiate for each detected object
     */
    public async requestObjectDetection(prompt: string, markerPrefab: ObjectPrefab): Promise<void> {
        if (this.isProcessing) {
            return;
        }
        this.isProcessing = true;
        
        try {
            this.showWorldMesh();
            this.clearAllDetections();
            this.depthCacheHelper.clearCapturedFrame();

            // 1. Capture camera frame AND depth frame
            const imageBase64 = await this.captureFrameAndDepth();
            if (!imageBase64) {
                throw new Error("Failed to capture camera frame");
            }
            
            // 2. Send to Gemini
            const results = await this.sendToGemini(imageBase64, prompt);
            

            // 3. Hide all existing markers
            const staleMarkers = this.currentMarkers;
            for (const marker of staleMarkers) {
                marker.enabled = false;
            }
            this.currentMarkers = [];
            this.detectedObjects.clear();
            
            // Spawn markers for each detection
            let markerIndex = 0;            
            for (const detection of results.objects) {
                if (detection.confidence < this.CONFIDENCE_THRESHOLD) {
                    continue;
                }
                
                const worldPos = this.depthCacheHelper.getWorldPosition(detection.x, detection.y);
                if (!worldPos) {
                    continue;
                }

                if (this.isWithinReachyExclusionZone(worldPos)) {
                    continue;
                }
                
                // Spawn marker
                const marker = markerPrefab.instantiate(null);
                marker.enabled = false;
                
                marker.getTransform().setWorldPosition(worldPos);
                const textComponent = this.findTextInChildren(marker);
                if (textComponent) {
                    textComponent.text = detection.name;
                }
                
                marker.enabled = true;
                this.animateMarkerIn(marker);

                if (this.reachyMiniManager) {
                    const lookAt = getInteractableLookAt(marker);
                    if (lookAt) {
                        lookAt.reachyMiniManager = this.reachyMiniManager;
                    }
                }
                
                this.currentMarkers.push(marker);
                markerIndex++;
                
                // Track detection
                const obj: DetectedObject = {
                    id: `${detection.name}_${Date.now()}_${markerIndex}`,
                    name: detection.name,
                    position: worldPos,
                    confidence: detection.confidence,
                    lastSeen: getTime(),
                    markerObject: marker
                };
                this.detectedObjects.set(obj.id, obj);
            }

            this.depthCacheHelper.clearCapturedFrame();

        } catch (error) {
            this.isProcessing = false;
            throw error;
        } finally {
            this.hideWorldMesh();
            this.isProcessing = false;
        }
    }

    // Capture a fresh camera frame and depth frame for this detection run.
    // Skips the first onNewFrame to avoid using a buffered/stale frame on subsequent runs.
    private captureFrameAndDepth(): Promise<string | null> {
        return new Promise((resolve) => {
            try {
                const cameraRequest = CameraModule.createCameraRequest();
                cameraRequest.cameraId = CameraModule.CameraId.Left_Color;
                const cameraTexture = this.cameraModule.requestCamera(cameraRequest);

                const textureProvider = cameraTexture.control as CameraTextureProvider;
                const onNewFrame = textureProvider.onNewFrame;

                const registration1 = onNewFrame.add(() => {
                    onNewFrame.remove(registration1);

                    // Second frame: guaranteed fresh after we subscribed (avoids stale buffer on run 2+)
                    const registration2 = onNewFrame.add(() => {
                        onNewFrame.remove(registration2);

                        this.depthCacheHelper.captureFrame();

                        Base64.encodeTextureAsync(
                            cameraTexture,
                            (base64String: string) => resolve(base64String),
                            () => resolve(null),
                            CompressionQuality.HighQuality,
                            EncodingType.Jpg
                        );
                    });
                });
            } catch (error) {
                resolve(null);
            }
        });
    }

    private async sendToGemini(imageBase64: string, prompt: string): Promise<GeminiDetectionResult> {
        const systemPrompt = `You are an object detection system. Analyze the image and return ONLY a JSON object with detected objects matching the user's query.

        Output format (strict JSON, no markdown):
        {
        "objects": [
            {"name": "object_name", "x": 0.5, "y": 0.5, "confidence": 0.95}
        ]
        }

        Rules:
        - x,y is the LOGICAL CENTER of the object — the point you would naturally point at or touch (e.g. the body of a mug, the screen of a monitor, the seat of a chair), NOT the geometric center of its bounding box
        - Coordinates are normalized 0-1 (0,0 is top-left, 1,1 is bottom-right)
        - confidence is 0-1 representing detection certainty
        - Return {"objects": []} if no objects found
        - Do NOT wrap in markdown code blocks
        - Return ONLY valid JSON`;
        
        const request: GeminiTypes.Models.GenerateContentRequest = {
            model: "gemini-2.5-flash-lite",
            type: "generateContent",
            body: {
                contents: [
                    { 
                        parts: [{ text: systemPrompt }], 
                        role: "model" 
                    },
                    { 
                        parts: [
                            { text: `User request: ${prompt}` },
                            { 
                                inline_data: { 
                                    mime_type: "image/jpeg", 
                                    data: imageBase64 
                                }
                            }
                        ], 
                        role: "user" 
                    }
                ],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 2048
                }
            }
        };
        
        const response = await Gemini.models(request);
        const jsonText = response.candidates[0].content.parts[0].text;
        
        // Clean JSON from response (remove markdown code blocks if present)
        let cleanJson = jsonText
            .replace(/```json\n?/g, "")
            .replace(/```\n?/g, "")
            .trim();
        
        try {
            return JSON.parse(cleanJson) as GeminiDetectionResult;
        } catch (parseError) {
            return { objects: [] };
        }
    }

    private isWithinReachyExclusionZone(worldPos: vec3): boolean {
        if (!this.worldMeshRoot) {
            return false;
        }
        const reachyPos = this.worldMeshRoot.getTransform().getWorldPosition();
        const dx = worldPos.x - reachyPos.x;
        const dy = worldPos.y - reachyPos.y;
        const dz = worldPos.z - reachyPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        return distSq <= this.REACHY_EXCLUSION_RADIUS_M * this.REACHY_EXCLUSION_RADIUS_M;
    }

    // ----------------------------------------------------------------
    // Accessor Helpers
    // ----------------------------------------------------------------
    public getTrackedObjectNames(): string[] {
        const names: string[] = [];
        this.detectedObjects.forEach((obj) => {
            names.push(obj.name);
        });
        return names;
    }

    public getTrackedObjectSummaries(): { name: string; x: number; y: number; z: number }[] {
        const summaries: { name: string; x: number; y: number; z: number }[] = [];
        this.detectedObjects.forEach((obj) => {
            summaries.push({ name: obj.name, x: obj.position.x, y: obj.position.y, z: obj.position.z });
        });
        return summaries;
    }
    
    public getObjectByName(name: string): DetectedObject | null {
        const searchName = name.toLowerCase();
        let bestMatch: DetectedObject | null = null;

        this.detectedObjects.forEach((obj) => {
            if (obj.name.toLowerCase().includes(searchName) || searchName.includes(obj.name.toLowerCase())) {
                if (!bestMatch || obj.confidence > bestMatch.confidence) {
                    bestMatch = obj;
                }
            }
        });
        return bestMatch;
    }



    // ----------------------------------------------------------------
    // Marker Animation
    // ----------------------------------------------------------------
    private findTextInChildren(obj: SceneObject): Text | null {
        // Check this object
        const text = obj.getComponent("Component.Text") as Text;
        if (text) return text;
        
        // Check children
        const childCount = obj.getChildrenCount();
        for (let i = 0; i < childCount; i++) {
            const child = obj.getChild(i);
            const found = this.findTextInChildren(child);
            if (found) return found;
        }
        
        return null;
    }

    // Animate a marker in with a scale animation
    private animateMarkerIn(marker: SceneObject): void {
        const startScale = new vec3(0, 0, 0);
        const targetScale = new vec3(1, 1, 1);
        
        animate({
            duration: 0.5,
            easing: "ease-in-out-quad",
            update: (t: number) => {
                if (isNull(marker)) return;
                const s = startScale.x + (targetScale.x - startScale.x) * t;
                marker.getTransform().setLocalScale(new vec3(s, s, s));
            }
        });
    }

    // ----------------------------------------------------------------
    // World Mesh
    // ----------------------------------------------------------------
    public showWorldMesh(): void {
        if (!this.worldMeshRenderer || !this.worldMeshRenderer.mainMaterial) {
            return;
        }
        if (this.worldMeshVisible) {
            return;
        }

        this.worldMeshVisible = true;

        const material = this.worldMeshRenderer.mainMaterial;

        // Set OriginLocation to worldMeshRoot's world position
        if (this.worldMeshRoot) {
            const originPos = this.worldMeshRoot.getTransform().getWorldPosition();
            material.mainPass.OriginLocation = originPos;
        }

        // Fade in from 0 to 1
        animate({
            duration: this.WM_FADE_IN_DURATION,
            easing: "ease-in-out-quad",
            update: (t: number) => {
                this.currentOpacity = t;
                material.mainPass.Opacity = this.currentOpacity;
            },
            ended: () => {
            }
        });
    }

    public hideWorldMesh(): void {
        if (!this.worldMeshRenderer || !this.worldMeshRenderer.mainMaterial) {
            return;
        }
        if (!this.worldMeshVisible) {
            return; // already hidden
        }

        this.worldMeshVisible = false;

        const material = this.worldMeshRenderer.mainMaterial;
        const startOpacity = this.currentOpacity;

        animate({
            duration: this.WM_FADE_OUT_DURATION,
            easing: "ease-in-out-quad",
            update: (t: number) => {
                this.currentOpacity = startOpacity * (1 - t);
                material.mainPass.Opacity = this.currentOpacity;
            }
        });
    }

}
