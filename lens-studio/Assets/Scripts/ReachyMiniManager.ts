import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import { PuppeteerMode } from "./Puppeteer/PuppeteerMode";
import { AssistantMode, AssistantState } from "./Assistant/AssistantMode";
import { RobotDriver } from "./RobotDriver/RobotDriver";

/**
 * Top-level orchestrator. SetupWizard completes first, then hands control here.
 *
 * Control flow:
 *   SetupWizard  -->  UIManager.setMode(n)  -->  ReachyMiniManager.setControlMode(n)
 *
 * Control modes:
 *   0 = Inactive    No update loop runs; robot holds last pose.
 *   1 = Puppeteer   PuppeteerMode.update() runs every frame (hand-drag gaze control).
 *   2 = Assistant    AssistantMode.updateFrame() runs every frame (voice AI + gaze).
 *
 * Each mode owns its own update loop (started/stopped by setControlMode).
 * setIsActive(false) pauses the current mode without switching; resume with setIsActive(true).
 */
@component
export class ReachyMiniManager extends BaseScriptComponent {

    @input
    private reachyMiniRoot: SceneObject | null = null;
    @input
    public robotDriver: RobotDriver | null = null;

    // State
    private isActive: boolean = false;

    // Positioning
    @input
    private positioningHologram: SceneObject | null = null;
    @input
    private positioningInteraction: Interactable | null = null;

    // Control Modes
    public controlMode: number = 0;
    @input
    public puppeteerMode: PuppeteerMode | null = null;
    @input
    public assistantMode: AssistantMode | null = null;

    private puppeteerUpdateEvent: SceneEvent | null = null;
    private assistantUpdateEvent: SceneEvent | null = null;
    private positioningEnabled: boolean = false;

    // --- Facade: assistant callback arrays ---
    public onAssistantStateChanged: ((state: AssistantState) => void)[] = [];
    public onSessionChanged: ((active: boolean) => void)[] = [];
    public onDebugForceShow: (() => void)[] = [];

    // Logger
    @input
    private textDebugInfo: Text | null = null;

    private logDebug(message: string): void {
        if (this.textDebugInfo) {
            this.textDebugInfo.text = message;
        }
    }

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            // Wire assistant callbacks as facades
            if (this.assistantMode) {
                this.assistantMode.onStateChanged.push((state: AssistantState) => {
                    this.onAssistantStateChanged.forEach(cb => cb(state));
                });
                this.assistantMode.onSessionChanged.push((active: boolean) => {
                    this.onSessionChanged.forEach(cb => cb(active));
                });
                this.assistantMode.onErrorOccurred.push((msg: string) => {
                    this.logDebug(msg);
                    this.onDebugForceShow.forEach(cb => cb());
                });
            }

            this.setPositioningEnabled(false);
            this.setControlMode(0);
        });
    }

    // ----------------------------------------------------------------
    // State
    // ---------------------------------------------------------------- 
    public setIsActive(isActive: boolean) {
        this.isActive = isActive;

        switch (this.controlMode) {
            case 0:
                break;
            case 1:
                if (this.puppeteerMode) {
                    isActive ? this.puppeteerMode.resume() : this.puppeteerMode.pause();
                }
                break;
            case 2:
                if (this.assistantMode) {
                    isActive ? this.assistantMode.resume() : this.assistantMode.pause();
                }
                break;
        }
    }

    public setControlMode(mode: number) {
        this.controlMode = mode;
        this.resetRobotToDefaultPose();

        switch (mode) {
            case 0:
                this.setControlMode0();
                this.logDebug("System - Control Mode: Inactive");
                break;
            case 1:
                this.setControlMode1();
                this.logDebug("System - Control Mode: Puppeteer");
                break;
            case 2:
                this.setControlMode2();
                this.logDebug("System - Control Mode: Assistant");
                break;
        }
    }

    private setControlMode0() {
        this.stopPuppeteerUpdateLoop();
        this.stopAssistantUpdateLoop();
        if (this.puppeteerMode) {
            this.puppeteerMode.deactivate();
        }
    }

    private setControlMode1() {
        this.stopAssistantUpdateLoop();
        if (this.puppeteerMode) {
            this.puppeteerMode.activate();
            this.startPuppeteerUpdateLoop();
        }
    }

    private setControlMode2() {
        this.stopPuppeteerUpdateLoop();
        if (this.puppeteerMode) {
            this.puppeteerMode.deactivate();
        }

        if (this.assistantMode) {
            this.assistantMode.activate();
            this.startAssistantUpdateLoop();
            if (!this.isActive) {
                this.assistantMode.pause();
            }
        }
    }


    // ----------------------------------------------------------------
    // Facade
    // ----------------------------------------------------------------
    public async checkConnection(): Promise<boolean> {
        return this.robotDriver ? this.robotDriver.checkConnection() : false;
    }

    public async connect(): Promise<void> {
        if (this.robotDriver) await this.robotDriver.connect();
    }

    public disconnect(): void {
        if (this.robotDriver) this.robotDriver.disconnect();
    }

    public setBaseUrl(url: string): void {
        if (this.robotDriver) this.robotDriver.setBaseUrl(url);
    }

    public getBaseUrl(): string {
        return this.robotDriver ? this.robotDriver.getBaseUrl() : "";
    }

    public setSimulationMode(enabled: boolean): void {
        if (this.robotDriver) {
            this.robotDriver.setSimulationMode(enabled);
        }
    }

    public get isSimulationMode(): boolean {
        return this.robotDriver ? this.robotDriver.getIsSimulationMode() : false;
    }

    public saveIp(ip: string): void {
        if (this.robotDriver) this.robotDriver.saveIp(ip);
    }

    public loadIp(): string | null {
        return this.robotDriver ? this.robotDriver.loadIp() : null;
    }

    public get isConversationActive(): boolean {
        return this.assistantMode ? this.assistantMode.currentState !== AssistantState.Sleeping : false;
    }


    // ----------------------------------------------------------------
    // Update Loops
    // ----------------------------------------------------------------
    private startPuppeteerUpdateLoop(): void {
        if (this.puppeteerUpdateEvent) return;
        this.puppeteerUpdateEvent = this.createEvent("UpdateEvent");
        this.puppeteerUpdateEvent.bind(() => {
            if (this.controlMode === 1 && this.puppeteerMode) {
                this.puppeteerMode.update();
            }
        });
    }

    private stopPuppeteerUpdateLoop(): void {
        if (this.puppeteerUpdateEvent) {
            this.removeEvent(this.puppeteerUpdateEvent);
            this.puppeteerUpdateEvent = null;
        }
        if (this.puppeteerMode) {
            this.puppeteerMode.pause();
        }
    }

    private startAssistantUpdateLoop(): void {
        if (this.assistantUpdateEvent) return;
        this.assistantUpdateEvent = this.createEvent("UpdateEvent");
        this.assistantUpdateEvent.bind(() => {
            if (this.controlMode === 2 && this.assistantMode) {
                this.assistantMode.updateFrame();
            }
        });
    }

    private stopAssistantUpdateLoop(): void {
        if (this.assistantUpdateEvent) {
            this.removeEvent(this.assistantUpdateEvent);
            this.assistantUpdateEvent = null;
        }
        if (this.assistantMode) {
            this.assistantMode.deactivate();
        }
    }

    // ----------------------------------------------------------------
    // Positioning
    // ----------------------------------------------------------------
    public setRootPosition(position: vec3, rotation: quat = quat.quatIdentity()) {
        if (this.reachyMiniRoot) {
            this.reachyMiniRoot.getTransform().setWorldPosition(position);
            this.reachyMiniRoot.getTransform().setWorldRotation(rotation);
        }
    }

    public setPositioningEnabled(enabled: boolean) {
        this.positioningEnabled = enabled;

        if (!this.isSimulationMode) {
            this.showReachyMiniMesh(enabled);
        }
        if (this.positioningInteraction) {
            this.positioningInteraction.enabled = enabled;
        }

        if (this.robotDriver) {
            if (this.positioningEnabled) {
                this.robotDriver.applyHologramMaterial();
            } else {
                this.robotDriver.applyDefaultMaterials();
            }
        }

        if (this.puppeteerMode) {
            this.puppeteerMode.reset();
        }
        this.resetRobotToDefaultPose();
    }


    // ----------------------------------------------------------------
    // Helper functions
    // ----------------------------------------------------------------
    public showReachyMiniMesh(enabled: boolean) {
        if (this.positioningHologram) {
            this.animateRobotBody(this.positioningHologram, enabled);
        }
    }

    private resetRobotToDefaultPose() {
        if (this.robotDriver) {
            const neutralPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
            this.robotDriver.goto(neutralPose, 0, 1.5, "minjerk").catch(() => {});
        }
    }

    private animateRobotBody(sceneObject: SceneObject, state: boolean, duration: number = 0.5, scale: vec3 = new vec3(1, 1, 1)): Promise<void> {
        if (state) {
            sceneObject.enabled = true;
        }
        const startScale = state ? new vec3(0, 0, 0) : scale;
        const targetScale = state ? scale : new vec3(0, 0, 0);
        return new Promise<void>((resolve) => {
            animate({
                duration: duration,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    const x = startScale.x + (targetScale.x - startScale.x) * t;
                    const y = startScale.y + (targetScale.y - startScale.y) * t;
                    const z = startScale.z + (targetScale.z - startScale.z) * t;
                    sceneObject.getTransform().setLocalScale(new vec3(x, y, z));
                },
                ended: () => {
                    if (!state) {
                        sceneObject.enabled = false;
                        sceneObject.getTransform().setLocalScale(new vec3(1, 1, 1));
                    }
                    resolve();
                },
            });
        });
    }

}
