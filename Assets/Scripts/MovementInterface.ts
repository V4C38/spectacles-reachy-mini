// Represents a 3D pose using position (x, y, z) in meters and orientation (roll, pitch, yaw) angles in radians
export interface XYZRPYPose {
    x: number;
    y: number;
    z: number;
    roll: number;
    pitch: number;
    yaw: number;
}

// Interface that both HardwareInterface and SimulationInterface implement
export interface IMovementInterface {
    goto(headPose: XYZRPYPose, bodyYaw?: number, duration?: number, interpolation?: string): Promise<string>;
    setTarget(headPose: XYZRPYPose, bodyYaw?: number, antennas?: [number, number]): Promise<void>;
    playAudio(audioTrack: AudioTrackAsset): Promise<void>;
}
