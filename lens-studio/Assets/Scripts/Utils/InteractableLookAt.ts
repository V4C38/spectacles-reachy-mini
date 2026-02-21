import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { ReachyMiniManager } from "../ReachyMiniManager";
import { getObjectLinkRenderer, ObjectLinkRenderer } from "./ObjectLinkRenderer";

/**
 * Attach to a prefab alongside an Interactable + Collider.
 * On tap, tells the robot to look at this object's world position
 * and draws a temporary line from the robot head to the object.
 *
 * For runtime-instantiated prefabs, inject reachyMiniManager and
 * lineRendererPrefab via the public properties after instantiation
 * (the @input fields are for editor wiring).
 */
@component
export class InteractableLookAt extends BaseScriptComponent {

    @input
    public reachyMiniManager: ReachyMiniManager | null = null;

    @input
    public lineRendererPrefab: ObjectPrefab | null = null;

    @input
    public duration: number = 2;

    private activeLine: ObjectLinkRenderer | null = null;

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            const interactable = this.sceneObject.getComponent(
                Interactable.getTypeName()
            ) as Interactable;
            if (!interactable) {
                throw new Error("InteractableLookAt: No Interactable found on this SceneObject");
            }
            interactable.onTriggerStart.add(() => this.onTapped());
        });
    }

    private onTapped(): void {
        const manager = this.reachyMiniManager;
        if (!manager?.robotDriver) return;

        const worldPos = this.sceneObject.getTransform().getWorldPosition();

        if (manager.controlMode === 2 && manager.assistantMode) {
            manager.assistantMode.lookAtOverrideTarget = worldPos;
            manager.assistantMode.lookAtOverrideEndTime = getTime() + this.duration;
        } else {
            manager.robotDriver.setGazeTarget(worldPos);
        }

        this.showLine(manager.robotDriver.getHeadWorldPosition(), worldPos);
    }

    private showLine(start: vec3, end: vec3): void {
        if (!this.lineRendererPrefab) return;

        if (this.activeLine) {
            this.activeLine.destroy();
            this.activeLine = null;
        }

        const lineObj = this.lineRendererPrefab.instantiate(null);
        lineObj.getTransform().setWorldPosition(start);

        const renderer = getObjectLinkRenderer(lineObj);
        if (!renderer) {
            lineObj.destroy();
            return;
        }

        renderer.setLineAndAppear(start, end);
        this.activeLine = renderer;

        const delayEvent = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent;
        delayEvent.bind(() => {
            if (this.activeLine === renderer) {
                this.activeLine = null;
            }
            renderer.destroy();
        });
        delayEvent.reset(0.5);
    }
}

/**
 * Find an InteractableLookAt component on the given scene object or any of its children.
 */
export function getInteractableLookAt(sceneObject: SceneObject): InteractableLookAt | null {
    const comp = sceneObject.getComponent("Component.ScriptComponent") as BaseScriptComponent;
    if (comp && comp instanceof InteractableLookAt) {
        return comp as InteractableLookAt;
    }
    const childCount = sceneObject.getChildrenCount();
    for (let i = 0; i < childCount; i++) {
        const found = getInteractableLookAt(sceneObject.getChild(i));
        if (found) return found;
    }
    return null;
}
