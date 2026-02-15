// ================================================================
// Robot Animation Configuration
// ================================================================
// Edit presets here to tune robot expressiveness without touching control logic.
// Callers (PuppeteerMode, AssistantMode) read presets and push them into RobotDriver.

/**
 * All multipliers that shape the animation loop in RobotDriver.
 * Every field scales a base value defined as an @input on RobotDriver.
 */
export interface AnimationParams {
    headMoveSpeedMul: number;    // gaze tracking speed
    maxHeadDeltaMul: number;     // max per-frame angle change
    rollAmplitudeMul: number;    // ambient roll / sway amount
    yBobAmplitudeMul: number;    // vertical head bob amount
    headYPosMul: number;         // vertical head offset (-1 = down, 1 = up)
    antennaAmplitudeMul: number; // antenna wiggle amount
    antennaSpeedMul: number;     // antenna wiggle speed
    gazeVariation: number;       // random gaze offset in radians (0 = exact tracking)
    bodyFollowMul: number;       // how much the body follows the head (0 = none, 1 = normal)
    pitchSmoothingMul: number;   // pitch-specific tracking speed
    /** When gaze target is null, use this pitch (radians). Positive = head down, negative = head up. 0 = straight ahead. */
    neutralPitchWhenNull?: number;
}

/**
 * Named presets. Callers pass these (or partials) to RobotDriver.setParams().
 */
export const PRESETS: Record<string, AnimationParams> = {
    //                            speed  delta  roll   yBob  yPos    ant    antSpd  gaze   body   pitch
    sleeping: {
        headMoveSpeedMul:   0.3,
        maxHeadDeltaMul:    0.3,
        rollAmplitudeMul:   0.2,
        yBobAmplitudeMul:   0.2,
        headYPosMul:       -0.55,   // head lowered more (more noticeable sleep)
        antennaAmplitudeMul:0.15,
        antennaSpeedMul:    0.5,
        gazeVariation:      0,
        bodyFollowMul:      0.3,
        pitchSmoothingMul:  0.3,
        neutralPitchWhenNull: 0.6,   // head tilted down further (radians; positive = look down)
    },
    idle: {
        headMoveSpeedMul:   0.6,
        maxHeadDeltaMul:    0.75,
        rollAmplitudeMul:   1.0,
        yBobAmplitudeMul:   1.0,
        headYPosMul:        0.5,
        antennaAmplitudeMul:1.0,
        antennaSpeedMul:    1.0,
        gazeVariation:      0,
        bodyFollowMul:      0.7,
        pitchSmoothingMul:  0.5,
    },
    listening: {
        headMoveSpeedMul:   1.0,
        maxHeadDeltaMul:    1.0,
        rollAmplitudeMul:   0.8,
        yBobAmplitudeMul:   0.6,
        headYPosMul:        0.8,
        antennaAmplitudeMul:1.3,
        antennaSpeedMul:    1.2,
        gazeVariation:      0.08,
        bodyFollowMul:      1.0,
        pitchSmoothingMul:  0.8,
    },
    speaking: {
        headMoveSpeedMul:   1.2,
        maxHeadDeltaMul:    1.0,
        rollAmplitudeMul:   1.0,
        yBobAmplitudeMul:   0.8,
        headYPosMul:        0.8,
        antennaAmplitudeMul:1.4,
        antennaSpeedMul:    1.3,
        gazeVariation:      0.12,
        bodyFollowMul:      1.0,
        pitchSmoothingMul:  0.8,
    },
    searching: {
        headMoveSpeedMul:   1.5,
        maxHeadDeltaMul:    1.5,
        rollAmplitudeMul:   0.6,
        yBobAmplitudeMul:   0.5,
        headYPosMul:        1.0,
        antennaAmplitudeMul:2.0,
        antennaSpeedMul:    1.5,
        gazeVariation:      0,
        bodyFollowMul:      1.0,
        pitchSmoothingMul:  1.0,
    },
    puppeteer: {
        headMoveSpeedMul:   1.2,
        maxHeadDeltaMul:    1.0,
        rollAmplitudeMul:   1.0,
        yBobAmplitudeMul:   1.5,
        headYPosMul:        0.6,
        antennaAmplitudeMul:0.8,
        antennaSpeedMul:    1.0,
        gazeVariation:      0,
        bodyFollowMul:      1.0,
        pitchSmoothingMul:  0.8,
    },
};

/** Context passed to animation gaze functions. */
export interface AnimationGazeContext {
    headPos: vec3;
    baseRotation: quat | null;
}

/** Returns gaze target (world position) for normalized time t in [0, 1]. */
export type AnimationGazeFn = (t: number, ctx: AnimationGazeContext) => vec3;

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

export const NAMED_ANIMATIONS: Record<string, NamedAnimationEntry> = {
    greeting: {
        durationSec: 2.5,
        params: {
            headMoveSpeedMul: 1.2, maxHeadDeltaMul: 1.8, rollAmplitudeMul: 2.5,
            yBobAmplitudeMul: 3.0, headYPosMul: 0.8, antennaAmplitudeMul: 2.8,
            antennaSpeedMul: 1.8, gazeVariation: 0, bodyFollowMul: 1.5, pitchSmoothingMul: 1.2,
        },
        audioKey: "greeting",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 120, x: 30 }, { t: 0.35, y: -50, x: -20 },
            { t: 0.55, y: 110, x: -30 }, { t: 0.75, y: -30, x: 20 }, { t: 0.9, y: 80 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    goodbye: {
        durationSec: 2.2,
        params: {
            headMoveSpeedMul: 1.0, maxHeadDeltaMul: 1.6, rollAmplitudeMul: 2.5,
            yBobAmplitudeMul: 2.0, headYPosMul: 0.4, antennaAmplitudeMul: 2.2,
            antennaSpeedMul: 1.6, gazeVariation: 0, bodyFollowMul: 1.5, pitchSmoothingMul: 0.9,
        },
        audioKey: "goodbye",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 80, x: 60 }, { t: 0.35, y: -40, x: -80 },
            { t: 0.55, y: 70, x: 70 }, { t: 0.75, y: -30, x: -50 }, { t: 0.9, y: 40 }, { t: 1, y: -60, x: 0 },
        ]),
    },
    happy: {
        durationSec: 2.0,
        params: {
            headMoveSpeedMul: 1.5, maxHeadDeltaMul: 2.0, rollAmplitudeMul: 2.5,
            yBobAmplitudeMul: 3.5, headYPosMul: 1.0, antennaAmplitudeMul: 3.0,
            antennaSpeedMul: 2.2, gazeVariation: 0, bodyFollowMul: 1.5, pitchSmoothingMul: 1.2,
        },
        audioKey: "happy",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.1, y: 140 }, { t: 0.22, y: -80, x: 40 }, { t: 0.35, y: 150, x: -50 },
            { t: 0.48, y: -70, x: 60 }, { t: 0.6, y: 130, x: -30 }, { t: 0.72, y: -60, x: 40 },
            { t: 0.85, y: 110 }, { t: 1, y: 0 },
        ]),
    },
    nod: {
        durationSec: 1.5,
        params: {
            headMoveSpeedMul: 1.6, maxHeadDeltaMul: 2.0, rollAmplitudeMul: 1.5,
            yBobAmplitudeMul: 2.0, headYPosMul: 0.8, antennaAmplitudeMul: 1.8,
            antennaSpeedMul: 1.5, gazeVariation: 0, bodyFollowMul: 1.2, pitchSmoothingMul: 1.5,
        },
        audioKey: "nod",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.2, y: 160, x: 20 }, { t: 0.4, y: -120, x: -60 },
            { t: 0.6, y: 150, x: 30 }, { t: 0.8, y: -100, x: -20 }, { t: 1, y: 0 },
        ]),
    },
    wave: {
        durationSec: 2.2,
        params: {
            headMoveSpeedMul: 1.2, maxHeadDeltaMul: 1.8, rollAmplitudeMul: 2.2,
            yBobAmplitudeMul: 2.0, headYPosMul: 0.7, antennaAmplitudeMul: 2.8,
            antennaSpeedMul: 2.0, gazeVariation: 0, bodyFollowMul: 1.5, pitchSmoothingMul: 1.0,
        },
        audioKey: "wave",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.12, y: 50, x: 120 }, { t: 0.28, y: -20, x: -100 },
            { t: 0.44, y: 60, x: 130 }, { t: 0.6, y: -30, x: -90 }, { t: 0.76, y: 40, x: 110 },
            { t: 0.9, y: 20, x: 0 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    sway: {
        durationSec: 3.0,
        params: {
            headMoveSpeedMul: 1.0, maxHeadDeltaMul: 1.6, rollAmplitudeMul: 2.8,
            yBobAmplitudeMul: 2.2, headYPosMul: 0.6, antennaAmplitudeMul: 2.0,
            antennaSpeedMul: 1.4, gazeVariation: 0, bodyFollowMul: 1.6, pitchSmoothingMul: 0.9,
        },
        audioKey: "sway",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.15, y: 40, x: 160 }, { t: 0.35, y: -20, x: -170 },
            { t: 0.5, y: 50, x: 160 }, { t: 0.65, y: -30, x: -170 }, { t: 0.8, y: 40, x: 150 },
            { t: 0.92, y: -10, x: -60 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    peekaboo: {
        durationSec: 3.0,
        params: {
            headMoveSpeedMul: 1.6, maxHeadDeltaMul: 2.0, rollAmplitudeMul: 2.0,
            yBobAmplitudeMul: 2.5, headYPosMul: 0.1, antennaAmplitudeMul: 2.5,
            antennaSpeedMul: 1.8, gazeVariation: 0, bodyFollowMul: 1.4, pitchSmoothingMul: 1.3,
        },
        audioKey: "peekaboo",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0, x: 0 }, { t: 0.25, y: -200, x: -40 }, { t: 0.4, y: -190, x: 30 },
            { t: 0.55, y: -180 }, { t: 0.65, y: 140, x: 20 }, { t: 0.8, y: 100, x: -30 }, { t: 1, y: 0, x: 0 },
        ]),
    },
    sad: {
        durationSec: 2.5,
        params: {
            headMoveSpeedMul: 0.6, maxHeadDeltaMul: 1.0, rollAmplitudeMul: 1.6,
            yBobAmplitudeMul: 0.6, headYPosMul: -0.6, antennaAmplitudeMul: 0.5,
            antennaSpeedMul: 0.4, gazeVariation: 0, bodyFollowMul: 0.6, pitchSmoothingMul: 0.6,
        },
        audioKey: "sad",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 0 }, { t: 0.15, y: -120 }, { t: 0.35, y: -200, x: -50 },
            { t: 0.55, y: -190, x: 30 }, { t: 0.75, y: -180, x: -20 }, { t: 1, y: -170 },
        ], 150),
    },
    excited: {
        durationSec: 2.0,
        params: {
            headMoveSpeedMul: 1.8, maxHeadDeltaMul: 2.0, rollAmplitudeMul: 2.5,
            yBobAmplitudeMul: 3.5, headYPosMul: 1.0, antennaAmplitudeMul: 3.0,
            antennaSpeedMul: 2.5, gazeVariation: 0, bodyFollowMul: 1.5, pitchSmoothingMul: 1.5,
        },
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
        params: {
            headMoveSpeedMul: 0.9, maxHeadDeltaMul: 1.4, rollAmplitudeMul: 2.5,
            yBobAmplitudeMul: 1.4, headYPosMul: 0.6, antennaAmplitudeMul: 1.2,
            antennaSpeedMul: 0.8, gazeVariation: 0, bodyFollowMul: 1.2, pitchSmoothingMul: 0.9,
        },
        audioKey: "thinking",
        getGazeTarget: makeGazeSequence([
            { t: 0, y: 40, x: 0 }, { t: 0.15, y: 70, x: 110 }, { t: 0.35, y: 30, x: -100 },
            { t: 0.55, y: 80, x: 120 }, { t: 0.75, y: 20, x: -90 }, { t: 0.9, y: 60, x: 50 },
            { t: 1, y: 40, x: 0 },
        ]),
    },
    dance: {
        durationSec: 5.0,
        params: {
            headMoveSpeedMul: 1.8, maxHeadDeltaMul: 2.2, rollAmplitudeMul: 3.0,
            yBobAmplitudeMul: 4.0, headYPosMul: 0.9, antennaAmplitudeMul: 3.5,
            antennaSpeedMul: 3.0, gazeVariation: 0, bodyFollowMul: 1.8, pitchSmoothingMul: 1.5,
        },
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
