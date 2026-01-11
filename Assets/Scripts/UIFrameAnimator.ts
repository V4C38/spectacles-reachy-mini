
import animate, {CancelFunction}  from "SpectaclesInteractionKit.lspkg/Utils/animate"
import Event, { PublicApi } from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { Frame } from "SpectaclesUIKit.lspkg/Scripts/Components/Frame/Frame";

@component
export class UIFrameAnimator extends BaseScriptComponent {

    @input
    private initialVisibility : boolean = true;
    private isVisible : boolean = true;

    @input
    private defaultScale : vec3 = new vec3(1, 1, 1);

    @input
    private frame : Frame | null = null;

    private currentAnimation : CancelFunction | null = null;

    // Event for when the frame visibility changes
    private _onFrameVisibilityChangedEvent: Event<boolean> = new Event<boolean>();
    readonly onFrameVisibilityChanged: PublicApi<boolean> = this._onFrameVisibilityChangedEvent.publicApi();

    onAwake() {
        if (!this.initialVisibility) {
            this.getSceneObject().getTransform().setLocalScale(new vec3(0, 0, 0));
            this.isVisible = false;
        }
    }

    // ------------------------------------------------------------------------------------------------
    // API
    // ------------------------------------------------------------------------------------------------
    public async animateShow() {
        await this.animateFrameVisibility(true);
    }

    public async animateHide() {
        await this.animateFrameVisibility(false);
    }

    public async animateFrameVisibility(visible : boolean, transform? : Transform) {

        let duration = 0.6;
        let following = this.frame.following;

        if (this.isVisible === visible) {
            return;
        }

        // Cancel any current animations
		if (this.currentAnimation !== null) {
			this.currentAnimation();
			this.currentAnimation = null;
		}

        // Set the location if provided
        const sceneObject = this.getSceneObject();
        if (transform) {
            if (following) {
                this.frame.setFollowing(false);
            }
            sceneObject.getTransform().setWorldPosition(transform.getWorldPosition());
            sceneObject.getTransform().setWorldRotation(transform.getWorldRotation());
        }

		// Use current local scale as starting point to avoid pops
		let startScale : vec3;
		startScale = sceneObject.getTransform().getLocalScale();

        let targetScale : vec3;
		targetScale = visible
			? this.defaultScale
			: new vec3(this.defaultScale.x, 0.00, this.defaultScale.z);

        // Modulate hide animation to be faster than show animation
        if (!visible) {
            duration *= 0.65;
        }

		await new Promise<void>((resolve) => {
			this.currentAnimation = animate({
				duration: duration,
				easing: "ease-in-out-quad",
				update: (t: number) => {
					const x = startScale.x + (targetScale.x - startScale.x) * t;
					const y = startScale.y + (targetScale.y - startScale.y) * t;
					const z = startScale.z + (targetScale.z - startScale.z) * t;
					sceneObject.getTransform().setLocalScale(new vec3(x, y, z));
				},
				ended: () => {
					resolve();
				},
				cancelled: () => {
					resolve();
				}
			});
		}).finally(() => {
			this.currentAnimation = null;
		});
        if (following) {
            this.frame.setFollowing(true);
        }
        this.isVisible = visible;
        this._onFrameVisibilityChangedEvent.invoke(visible);
    }
}
