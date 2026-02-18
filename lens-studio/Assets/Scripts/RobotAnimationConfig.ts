// ================================================================
// Robot Animation Configuration
// ================================================================
// Edit presets here to tune robot expressiveness without touching control logic.

// Animation parameters used by RobotDriver.
export interface AnimationParams {
    liveliness: number;         // 0-2: ambient motion intensity (roll sway, head bob, body follow)
    gazeResponsiveness: number; // 0-2: gaze tracking speed and precision
    headHeight: number;         // -1 to 1: vertical head position (down to up)
    antennaActivity: number;    // 0-3: antenna wiggle intensity (drives both amplitude and speed)
    gazeWander: number;         // 0-0.2: random gaze offset in radians (0 = exact tracking)
}

// Named presets. Callers (e.g. AssistantModeTools) pass these to RobotDriver
export const PRESETS: Record<string, AnimationParams> = {
    //                          lively  gaze   height  antenna  wander
    sleeping:  { liveliness: 0.2,  gazeResponsiveness: 0.3, headHeight: -0.55, antennaActivity: 0.15, gazeWander: 0    },
    idle:      { liveliness: 1.0,  gazeResponsiveness: 0.6, headHeight:  0.5,  antennaActivity: 1.0,  gazeWander: 0    },
    listening: { liveliness: 0.7,  gazeResponsiveness: 1.0, headHeight:  0.8,  antennaActivity: 1.3,  gazeWander: 0.08 },
    speaking:  { liveliness: 0.9,  gazeResponsiveness: 1.2, headHeight:  0.8,  antennaActivity: 1.4,  gazeWander: 0.12 },
    searching: { liveliness: 0.55, gazeResponsiveness: 1.5, headHeight:  1.0,  antennaActivity: 2.0,  gazeWander: 0    },
    puppeteer: { liveliness: 1.25, gazeResponsiveness: 1.2, headHeight:  0.6,  antennaActivity: 0.8,  gazeWander: 0    },
};


/**
 * Named animations: characterful param presets with duration, audio, and optional gaze override.
 * During the animation, params AND gaze fully override the normal loop.
 */
export interface NamedAnimationEntry {
    durationSec: number;
    params: AnimationParams;
    audioKey: string;
    /** Optional: overrides gaze target during animation. t goes 0->1 over duration. */
    getGazeTarget?: AnimationGazeFn;
}

export const NAMED_ANIMATIONS: Record<string, NamedAnimationEntry> = {
    greeting: {
        durationSec: 2.5,
        params: { liveliness: 2.8, gazeResponsiveness: 1.5, headHeight: 0.8, antennaActivity: 2.8, gazeWander: 0 },
        audioKey: "greeting",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 120, x: 30 }, { t: 0.35, y: -50, x: -20 },
            { t: 0.55, y: 110, x: -30 }, { t: 0.75, y: -30, x: 20 }, { t: 0.9, y: 80 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    goodbye: {
        durationSec: 2.2,
        params: { liveliness: 2.2, gazeResponsiveness: 1.3, headHeight: 0.4, antennaActivity: 2.2, gazeWander: 0 },
        audioKey: "goodbye",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 80, x: 60 }, { t: 0.35, y: -40, x: -80 },
            { t: 0.55, y: 70, x: 70 }, { t: 0.75, y: -30, x: -50 }, { t: 0.9, y: 40 }, { t: 1, y: -60, x: 0 },
        ]),
    },
    happy: {
        durationSec: 2.0,
        params: { liveliness: 3.0, gazeResponsiveness: 1.8, headHeight: 1.0, antennaActivity: 3.0, gazeWander: 0 },
        audioKey: "happy",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.1, y: 140 }, { t: 0.22, y: -80, x: 40 }, { t: 0.35, y: 150, x: -50 },
            { t: 0.48, y: -70, x: 60 }, { t: 0.6, y: 130, x: -30 }, { t: 0.72, y: -60, x: 40 },
            { t: 0.85, y: 110 }, { t: 1, y: 0 },
        ]),
    },
    nod: {
        durationSec: 1.5,
        params: { liveliness: 1.8, gazeResponsiveness: 1.8, headHeight: 0.8, antennaActivity: 1.8, gazeWander: 0 },
        audioKey: "nod",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.2, y: 160, x: 20 }, { t: 0.4, y: -120, x: -60 },
            { t: 0.6, y: 150, x: 30 }, { t: 0.8, y: -100, x: -20 }, { t: 1, y: 0 },
        ]),
    },
    wave: {
        durationSec: 2.2,
        params: { liveliness: 2.2, gazeResponsiveness: 1.5, headHeight: 0.7, antennaActivity: 2.8, gazeWander: 0 },
        audioKey: "wave",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.12, y: 50, x: 120 }, { t: 0.28, y: -20, x: -100 },
            { t: 0.44, y: 60, x: 130 }, { t: 0.6, y: -30, x: -90 }, { t: 0.76, y: 40, x: 110 },
            { t: 0.9, y: 20, x: 0 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    sway: {
        durationSec: 3.0,
        params: { liveliness: 2.5, gazeResponsiveness: 1.3, headHeight: 0.6, antennaActivity: 2.0, gazeWander: 0 },
        audioKey: "sway",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 40, x: 160 }, { t: 0.35, y: -20, x: -170 },
            { t: 0.5, y: 50, x: 160 }, { t: 0.65, y: -30, x: -170 }, { t: 0.8, y: 40, x: 150 },
            { t: 0.92, y: -10, x: -60 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    peekaboo: {
        durationSec: 3.0,
        params: { liveliness: 2.2, gazeResponsiveness: 1.8, headHeight: 0.1, antennaActivity: 2.5, gazeWander: 0 },
        audioKey: "peekaboo",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.25, y: -200, x: -40 }, { t: 0.4, y: -190, x: 30 },
            { t: 0.55, y: -180 }, { t: 0.65, y: 140, x: 20 }, { t: 0.8, y: 100, x: -30 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    sad: {
        durationSec: 2.5,
        params: { liveliness: 0.6, gazeResponsiveness: 0.8, headHeight: -0.6, antennaActivity: 0.5, gazeWander: 0 },
        audioKey: "sad",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.15, y: -120 }, { t: 0.35, y: -200, x: -50 },
            { t: 0.55, y: -190, x: 30 }, { t: 0.75, y: -180, x: -20 }, { t: 1, y: -170 },
        ], 150),
    },
    excited: {
        durationSec: 2.0,
        params: { liveliness: 3.0, gazeResponsiveness: 1.9, headHeight: 1.0, antennaActivity: 3.0, gazeWander: 0 },
        audioKey: "excited",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.08, y: 140, x: 50 }, { t: 0.18, y: -100, x: -60 },
            { t: 0.28, y: 150, x: -40 }, { t: 0.4, y: -110, x: 70 }, { t: 0.52, y: 130, x: -50 },
            { t: 0.64, y: -90, x: 60 }, { t: 0.76, y: 120, x: -30 }, { t: 0.88, y: -70, x: 40 },
            { t: 1, y: 0, x: 0 },
        ]),
    },
    thinking: {
        durationSec: 2.5,
        params: { liveliness: 1.8, gazeResponsiveness: 1.1, headHeight: 0.6, antennaActivity: 1.2, gazeWander: 0 },
        audioKey: "thinking",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 40, x: 0 }, { t: 0.15, y: 70, x: 110 }, { t: 0.35, y: 30, x: -100 },
            { t: 0.55, y: 80, x: 120 }, { t: 0.75, y: 20, x: -90 }, { t: 0.9, y: 60, x: 50 },
            { t: 1, y: 40, x: 0 },
        ]),
    },
    dance: {
        durationSec: 5.0,
        params: { liveliness: 3.5, gazeResponsiveness: 2.0, headHeight: 0.9, antennaActivity: 3.5, gazeWander: 0 },
        audioKey: "dance",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 },
            { t: 0.06, y: 130, x: 110 }, { t: 0.12, y: -100, x: -120 },
            { t: 0.18, y: 140, x: -90 }, { t: 0.24, y: -110, x: 130 },
            { t: 0.30, y: 120, x: 0 }, { t: 0.36, y: -120, x: -140 },
            { t: 0.42, y: 150, x: 110 }, { t: 0.48, y: -90, x: -100 },
            { t: 0.54, y: 110, x: 140 }, { t: 0.60, y: -130, x: -80 },
            { t: 0.66, y: 140, x: 100 }, { t: 0.72, y: -100, x: -130 },
            { t: 0.78, y: 120, x: 90 }, { t: 0.84, y: -80, x: -110 },
            { t: 0.90, y: 100, x: 60 }, { t: 0.95, y: -40, x: -30 },
            { t: 1, y: 0, x: 0 },
        ]),
    },
};


export interface AnimationGazeContext {
    headPos: vec3;
    baseRotation: quat | null;
}

export type AnimationGazeFn = (t: number, ctx: AnimationGazeContext) => vec3;


function forwardPoint(ctx: AnimationGazeContext, dist: number): vec3 {
    const fwd = ctx.baseRotation ? ctx.baseRotation.multiplyVec3(new vec3(0, 0, 1)) : new vec3(0, 0, 1);
    return ctx.headPos.add(fwd.uniformScale(dist));
}

function rightVec(ctx: AnimationGazeContext): vec3 {
    return ctx.baseRotation ? ctx.baseRotation.multiplyVec3(new vec3(1, 0, 0)) : new vec3(1, 0, 0);
}

/** Gaze keyframe: t in [0,1], y=vertical offset (up+), x=horizontal offset (right+). */
interface GazeKeyframe { t: number; y: number; x?: number; }

function lerpKeyframe(t: number, keyframes: GazeKeyframe[]): { y: number; x: number } {
    if (keyframes.length === 0) return { y: 0, x: 0 };
    const tClamped = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < keyframes.length - 1 && keyframes[i + 1].t <= tClamped) i++;
    const a = keyframes[i];
    const b = i < keyframes.length - 1 ? keyframes[i + 1] : a;
    const segT = a.t === b.t ? 1 : (tClamped - a.t) / (b.t - a.t);
    const y = a.y + (b.y - a.y) * segT;
    const x = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * segT;
    return { y, x };
}

/** Helper to create a gaze-sequence fn from keyframes. */
function makeGazeSequence(keyframes: GazeKeyframe[], dist: number = 200): AnimationGazeFn {
    return (t: number, ctx: AnimationGazeContext) => {
        const { y, x } = lerpKeyframe(t, keyframes);
        const right = rightVec(ctx);
        return forwardPoint(ctx, dist).add(new vec3(0, y, 0)).add(right.uniformScale(x));
    };
}
