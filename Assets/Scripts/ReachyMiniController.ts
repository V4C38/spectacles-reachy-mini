import {RoundButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RoundButton"
import animate, {CancelFunction} from "SpectaclesInteractionKit.lspkg/Utils/animate"

@component
export class ReachyMiniController extends BaseScriptComponent {
    @input("Component.ScriptComponent")
    @hint("Reference to the DaemonInterface component (singleton)")
    private daemonInterface!: ScriptComponent;

    @input
    @hint("RoundButton component from Spectacles UI Kit (should be set to toggleable mode)")
    private roundButton!: RoundButton;

    @input
    @hint("SceneObject entity to show/hide based on button toggle state")
    private controlledEntity!: SceneObject;

    private currentAnimation: CancelFunction | null = null;

    onAwake() {

        // LookAt entity state / button events
        if (this.roundButton) {
            // onValueChange fires with 1 when on, 0 when off
            this.roundButton.onValueChange.add((value: number) => {
                const isToggledOn = value === 1;
                this.animateLookAtEntity(isToggledOn);
            });

            this.animateLookAtEntity(this.roundButton.isOn);
        }
    }


    // -----------------------------------------------------------------------------------------
    // API
    // -----------------------------------------------------------------------------------------
    private async animateLookAtEntity(state: boolean) {
        if (!this.controlledEntity) {
            return;
        }

        if (this.currentAnimation !== null) {
            this.currentAnimation();
            this.currentAnimation = null;
        }

        const transform = this.controlledEntity.getTransform();
        const startScale = state ? new vec3(0, 0, 0) : transform.getLocalScale();
        const targetScale = state ? new vec3(0.5, 0.5, 0.5) : new vec3(0, 0, 0);
        const startPos = transform.getLocalPosition();
        const targetPos = new vec3(0, 15, 0);

        if (state) {
            this.controlledEntity.enabled = true;
        }

        await new Promise<void>((resolve) => {
            this.currentAnimation = animate({
                duration: 1.0,
                easing: "ease-in-out-quad",
                update: (t: number) => {
                    const scaleX = startScale.x + (targetScale.x - startScale.x) * t;
                    const scaleY = startScale.y + (targetScale.y - startScale.y) * t;
                    const scaleZ = startScale.z + (targetScale.z - startScale.z) * t;
                    transform.setLocalScale(new vec3(scaleX, scaleY, scaleZ));

                    const posX = startPos.x + (targetPos.x - startPos.x) * t;
                    const posY = startPos.y + (targetPos.y - startPos.y) * t;
                    const posZ = startPos.z + (targetPos.z - startPos.z) * t;
                    transform.setLocalPosition(new vec3(posX, posY, posZ));
                },
                ended: () => {
                    if (!state) this.controlledEntity.enabled = false;
                    resolve();
                },
                cancelled: () => {
                    if (!state) this.controlledEntity.enabled = false;
                    resolve();
                }
            });
        }).finally(() => {
            this.currentAnimation = null;
        });
    }
}
