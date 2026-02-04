import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";

import { IMovementInterface } from "./MovementInterface";
import { HardwareInterface } from "./HardwareInterface";
import { ControllerPuppeteer } from "./ControllerPuppeteer";
import { PersistenceManager } from "./PersistenceManager";
import { SimulationInterface } from "./SimulationInterface";


@component
export class ReachyMiniManager extends BaseScriptComponent {

    @input
    private reachyMiniRoot : SceneObject | null = null;
    @input
    private headRoot : SceneObject | null = null;


    @input
    public hardwareInterface : HardwareInterface | null = null;
    @input
    public simulationInterface : SimulationInterface | null = null;
    @input
    public persistenceManager : PersistenceManager | null = null;

    // State
    private isActive : boolean = false;
    public isSimulationMode : boolean = false;


    // Positioning
    @input
    private positioningHologram : SceneObject | null = null;
    @input
    private positioningInteraction : Interactable | null = null;

    // Control Modes
    private controlMode : number = 0;
    private puppeteer: ControllerPuppeteer | null = null;
    private puppeteerUpdateEvent: SceneEvent | null = null;
    
    private positioningEnabled: boolean = false;

    @input
    private mode1Interactable : Interactable | null = null;
    @input
    private mode1InteractableVFX : RenderMeshVisual | null = null;
    @input
    private mode1InteractableRoot : SceneObject | null = null;



    onAwake() {
        // Defer initialization to OnStartEvent when inputs are ready
        this.createEvent("OnStartEvent").bind(() => {
            this.setPositioningEnabled(false);
            this.setControlMode(0);
            
            // Save anchor when positioning interaction ends
            if (this.positioningInteraction) {
                this.positioningInteraction.onTriggerEnd.add(() => {
                    this.saveCurrentPosition();
                });
            }
        });
    }

    // ------------------------------------------------------------
    // Is Active
    // ------------------------------------------------------------
    public setIsActive(isActive : boolean) {
        this.isActive = isActive;

        switch (this.controlMode) {
            case 0:
                break;
            case 1:
                if (this.mode1InteractableVFX) {
                    this.mode1InteractableVFX.mainPass.Tweak_N41 = isActive ? 1 : 0;
                }
                break;
            case 2:
                break;
        }
    }

    // ------------------------------------------------------------
    // Simulation Mode
    // ------------------------------------------------------------
    public setSimulationMode(enabled: boolean): void {
        this.isSimulationMode = enabled;
        this.puppeteer = null;
    }

    private getMovementInterface(): IMovementInterface | null {
        if (this.isSimulationMode) {
            return this.simulationInterface;
        }
        return this.hardwareInterface;
    }

    // ------------------------------------------------------------
    // ControlMode
    // ------------------------------------------------------------
    public setControlMode(mode : number) {
        this.controlMode = mode;
        switch (mode) {
            case 0:
                this.setControlMode0();
                break;
            case 1:
                this.setControlMode1();
                break;
            case 2:
                this.setControlMode2();
                break;
        }
    }

    private setControlMode0() {
        this.stopPuppeteerUpdateLoop();
        if (this.mode1Interactable) {
            this.mode1Interactable.sceneObject.enabled = false;
        }
    }

    private setControlMode1() {
        const movementInterface = this.getMovementInterface();
        if (this.mode1Interactable && this.mode1InteractableRoot && this.headRoot && movementInterface) {
            
            // Reset the target interactable position
            this.mode1Interactable.sceneObject.getTransform().setWorldPosition(this.mode1InteractableRoot.getTransform().getWorldPosition());
            this.animateSceneObjectState(this.mode1Interactable.sceneObject, true, 0.75, new vec3(0.35, 0.35, 0.35));

            // Puppeteer Controller
            if (!this.puppeteer) {
                this.puppeteer = new ControllerPuppeteer(
                    movementInterface,
                    this.mode1Interactable.sceneObject,
                    this.headRoot
                );
            }
            this.puppeteer.reset();
            this.startPuppeteerUpdateLoop();
        }
    }

    private setControlMode2() {
        this.stopPuppeteerUpdateLoop();
        if (this.mode1Interactable) {
            this.animateSceneObjectState(this.mode1Interactable.sceneObject, false, 0.4);
        }
    }

    private startPuppeteerUpdateLoop(): void {
        if (this.puppeteerUpdateEvent) {
            return;
        }
        this.puppeteerUpdateEvent = this.createEvent("UpdateEvent");
        this.puppeteerUpdateEvent.bind(() => {
            if (this.controlMode === 1 && this.isActive && this.puppeteer) {
                this.puppeteer.update();
            }
        });
    }

    private stopPuppeteerUpdateLoop(): void {
        if (this.puppeteerUpdateEvent) {
            this.removeEvent(this.puppeteerUpdateEvent);
            this.puppeteerUpdateEvent = null;
        }
    }

    // ------------------------------------------------------------
    // Positioning
    // ------------------------------------------------------------
    public setRootPosition(position : vec3, rotation : quat = quat.quatIdentity()) {
        if (this.reachyMiniRoot) {
            this.reachyMiniRoot.getTransform().setWorldPosition(position);
            this.reachyMiniRoot.getTransform().setWorldRotation(rotation);
        }
    }

    public setPositioningEnabled(enabled : boolean) {
        this.positioningEnabled = enabled;

        if (!this.isSimulationMode) {
            this.showReachyMiniMesh(enabled);
        }
        if (this.positioningInteraction) {
            this.positioningInteraction.enabled = enabled;
        }
        
        // Reset robot to default pose
        const movementInterface = this.getMovementInterface();
        if (movementInterface) {
            const neutralPose = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
            movementInterface.goto(neutralPose, 0, 1.5, "minjerk");
        }
    }

    public showReachyMiniMesh(enabled : boolean) {
        if (this.positioningHologram) {
            this.animateSceneObjectState(this.positioningHologram, enabled);
        }     
    }


    // ------------------------------------------------------------
    // Helper functions
    // ------------------------------------------------------------
    private animateSceneObjectState(sceneObject : SceneObject, state : boolean, duration : number = 0.5, scale : vec3 = new vec3(1, 1, 1)): Promise<void> {
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
                    }
                    resolve();
                },
            });
        });
    }

    // ------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------
    public async saveCurrentPosition(): Promise<void> {
        if (this.persistenceManager && this.reachyMiniRoot) {
            const position = this.reachyMiniRoot.getTransform().getWorldPosition();
            await this.persistenceManager.saveAnchorPosition(position);
        }
    }
}
