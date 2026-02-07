/**
 * Represents a detected object in the scene with its marker
 */
export interface DetectedObject {
    id: string;                 // Unique identifier
    name: string;               // Object class name
    position: vec3;             // World position
    confidence: number;         // Detection confidence (0-1)
    lastSeen: number;           // Timestamp of last detection
    markerObject: SceneObject;  // Reference to spawned marker
}

/**
 * Single detection result from Gemini
 */
export interface DetectionItem {
    name: string;
    x: number;          // Logical center X (0-1 normalized)
    y: number;          // Logical center Y (0-1 normalized)
    confidence: number;
}

/**
 * Complete response structure from Gemini object detection
 */
export interface GeminiDetectionResult {
    objects: DetectionItem[];
}
