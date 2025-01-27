// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { toNanoSec } from "@foxglove/rostime";
import {
  SettingsTreeAction,
  SettingsTreeFields,
} from "@foxglove/studio-base/components/SettingsTreeEditor/types";

import { BaseUserData, Renderable } from "../Renderable";
import { Renderer } from "../Renderer";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { makeRgba, rgbaToCssString, stringToRgba } from "../color";
import { normalizeHeader, normalizeMatrix6, normalizePose } from "../normalizeMessages";
import {
  Marker,
  PoseWithCovarianceStamped,
  PoseStamped,
  POSE_WITH_COVARIANCE_STAMPED_DATATYPES,
  MarkerAction,
  MarkerType,
  TIME_ZERO,
  POSE_STAMPED_DATATYPES,
  PoseWithCovariance,
} from "../ros";
import { BaseSettings } from "../settings";
import { makePose, Pose } from "../transforms";
import { RenderableArrow } from "./markers/RenderableArrow";
import { RenderableSphere } from "./markers/RenderableSphere";

export type LayerSettingsPose = BaseSettings & {
  scale: [number, number, number];
  color: string;
  showCovariance: boolean;
  covarianceColor: string;
};

const DEFAULT_SCALE: THREE.Vector3Tuple = [1, 0.15, 0.15];
const DEFAULT_COLOR = { r: 124 / 255, g: 107 / 255, b: 1, a: 1 };
const DEFAULT_COVARIANCE_COLOR = { r: 198 / 255, g: 107 / 255, b: 1, a: 0.25 };

const DEFAULT_COLOR_STR = rgbaToCssString(DEFAULT_COLOR);
const DEFAULT_COVARIANCE_COLOR_STR = rgbaToCssString(DEFAULT_COVARIANCE_COLOR);

const DEFAULT_SETTINGS: LayerSettingsPose = {
  visible: true,
  scale: DEFAULT_SCALE,
  color: DEFAULT_COLOR_STR,
  showCovariance: true,
  covarianceColor: DEFAULT_COVARIANCE_COLOR_STR,
};

export type PoseUserData = BaseUserData & {
  settings: LayerSettingsPose;
  topic: string;
  poseMessage: PoseStamped | PoseWithCovarianceStamped;
  arrow: RenderableArrow;
  sphere?: RenderableSphere;
};

export class PoseRenderable extends Renderable<PoseUserData> {
  override dispose(): void {
    this.userData.arrow.dispose();
    this.userData.sphere?.dispose();
    super.dispose();
  }
}

export class Poses extends SceneExtension<PoseRenderable> {
  constructor(renderer: Renderer) {
    super("foxglove.Poses", renderer);

    renderer.addDatatypeSubscriptions(POSE_STAMPED_DATATYPES, this.handlePoseStamped);
    renderer.addDatatypeSubscriptions(
      POSE_WITH_COVARIANCE_STAMPED_DATATYPES,
      this.handlePoseWithCovariance,
    );
  }

  override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      const isPoseStamped = POSE_STAMPED_DATATYPES.has(topic.datatype);
      const isPoseWithCovarianceStamped = isPoseStamped
        ? false
        : POSE_WITH_COVARIANCE_STAMPED_DATATYPES.has(topic.datatype);
      if (isPoseStamped || isPoseWithCovarianceStamped) {
        const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsPose>;

        // prettier-ignore
        const fields: SettingsTreeFields = {
          scale: { label: "Scale", input: "vec3", labels: ["X", "Y", "Z"], step: 0.5, precision: 3, value: config.scale ?? DEFAULT_SCALE },
          color: { label: "Color", input: "rgba", value: config.color ?? DEFAULT_COLOR_STR },
        };

        if (isPoseWithCovarianceStamped) {
          const showCovariance = config.showCovariance ?? true;
          const covarianceColor = config.covarianceColor ?? DEFAULT_COVARIANCE_COLOR_STR;

          fields["showCovariance"] = {
            label: "Covariance",
            input: "boolean",
            value: showCovariance,
          };
          if (showCovariance) {
            fields["covarianceColor"] = {
              label: "Covariance Color",
              input: "rgba",
              value: covarianceColor,
            };
          }
        }

        entries.push({
          path: ["topics", topic.name],
          node: {
            label: topic.name,
            icon: "Flag",
            fields,
            visible: config.visible ?? true,
            handler,
          },
        });
      }
    }
    return entries;
  }

  handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }

    this.saveSetting(path, action.payload.value);

    // Update the renderable
    const topicName = path[1]!;
    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const settings = this.renderer.config.topics[topicName] as
        | Partial<LayerSettingsPose>
        | undefined;
      renderable.userData.settings = { ...renderable.userData.settings, ...settings };
      this._updatePoseRenderable(
        renderable,
        renderable.userData.poseMessage,
        renderable.userData.receiveTime,
      );
    }
  };

  handlePoseStamped = (messageEvent: PartialMessageEvent<PoseStamped>): void => {
    const poseMessage = normalizePoseStamped(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPose(messageEvent.topic, poseMessage, receiveTime);
  };

  handlePoseWithCovariance = (
    messageEvent: PartialMessageEvent<PoseWithCovarianceStamped>,
  ): void => {
    const poseMessage = normalizePoseWithCovarianceStamped(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPose(messageEvent.topic, poseMessage, receiveTime);
  };

  addPose(
    topic: string,
    poseMessage: PoseStamped | PoseWithCovarianceStamped,
    receiveTime: bigint,
  ): void {
    let renderable = this.renderables.get(topic);
    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsPose>
        | undefined;
      const settings = { ...DEFAULT_SETTINGS, ...userSettings };

      // Synthesize an arrow marker to instantiate a RenderableArrow
      const arrowMarker = createArrowMarker(poseMessage, settings);
      const arrow = new RenderableArrow(topic, arrowMarker, undefined, this.renderer);

      const poseWithCovariance = ("covariance" in poseMessage.pose ? poseMessage : undefined) as
        | PoseWithCovarianceStamped
        | undefined;

      renderable = new PoseRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(poseMessage.header.stamp),
        frameId: poseMessage.header.frame_id,
        pose: (poseWithCovariance?.pose.pose ?? poseMessage.pose) as Pose,
        settingsPath: ["topics", topic],
        settings,
        topic,
        poseMessage,
        arrow,
        sphere: undefined,
      });
      renderable.add(arrow);

      if (poseWithCovariance) {
        const sphereMarker = createSphereMarker(poseWithCovariance, settings);
        if (sphereMarker) {
          renderable.userData.sphere = new RenderableSphere(
            topic,
            sphereMarker,
            undefined,
            this.renderer,
          );
          renderable.add(renderable.userData.sphere);
        }
      }

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    this._updatePoseRenderable(renderable, poseMessage, receiveTime);
  }

  _updatePoseRenderable(
    renderable: PoseRenderable,
    poseMessage: PoseStamped | PoseWithCovarianceStamped,
    receiveTime: bigint,
  ): void {
    renderable.userData.receiveTime = receiveTime;
    renderable.userData.messageTime = toNanoSec(poseMessage.header.stamp);
    renderable.userData.frameId = poseMessage.header.frame_id;
    renderable.userData.poseMessage = poseMessage;

    const arrowMarker = createArrowMarker(poseMessage, renderable.userData.settings);
    renderable.userData.arrow.update(arrowMarker, undefined);

    if ("covariance" in poseMessage.pose) {
      renderable.userData.pose = poseMessage.pose.pose;

      const poseWithCovariance = poseMessage as PoseWithCovarianceStamped;
      const sphereMarker = createSphereMarker(poseWithCovariance, renderable.userData.settings);
      if (sphereMarker) {
        if (!renderable.userData.sphere) {
          renderable.userData.sphere = new RenderableSphere(
            renderable.userData.topic,
            sphereMarker,
            undefined,
            this.renderer,
          );
        }
        renderable.userData.sphere.visible = renderable.userData.settings.showCovariance;
        renderable.userData.sphere.update(sphereMarker, undefined);
      } else if (renderable.userData.sphere) {
        renderable.userData.sphere.visible = false;
      }
    } else {
      renderable.userData.pose = poseMessage.pose;
    }
  }
}

function createArrowMarker(
  poseMessage: PoseStamped | PoseWithCovarianceStamped,
  settings: LayerSettingsPose,
): Marker {
  return {
    header: poseMessage.header,
    ns: "",
    id: 0,
    type: MarkerType.ARROW,
    action: MarkerAction.ADD,
    pose: makePose(),
    scale: { x: settings.scale[0], y: settings.scale[1], z: settings.scale[2] },
    color: stringToRgba(makeRgba(), settings.color),
    lifetime: TIME_ZERO,
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function createSphereMarker(
  poseMessage: PoseWithCovarianceStamped,
  settings: LayerSettingsPose,
): Marker | undefined {
  // Covariance is a 6x6 matrix for position and rotation (XYZ, RPY)
  // We currently only visualize position variance so extract the upper-left
  // 3x1 diagonal
  // [X, -, -, -, -, -]
  // [-, Y, -, -, -, -]
  // [-, -, Z, -, -, -]
  // [-, -, -, -, -, -]
  // [-, -, -, -, -, -]
  // [-, -, -, -, -, -]
  const K = poseMessage.pose.covariance;
  const scale = { x: Math.sqrt(K[0]), y: Math.sqrt(K[7]), z: Math.sqrt(K[14]) };

  return {
    header: poseMessage.header,
    ns: "",
    id: 1,
    type: MarkerType.SPHERE,
    action: MarkerAction.ADD,
    pose: makePose(),
    scale,
    color: stringToRgba(makeRgba(), settings.covarianceColor),
    lifetime: TIME_ZERO,
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function normalizePoseStamped(pose: PartialMessage<PoseStamped>): PoseStamped {
  return {
    header: normalizeHeader(pose.header),
    pose: normalizePose(pose.pose),
  };
}

function normalizePoseWithCovariance(
  pose: PartialMessage<PoseWithCovariance> | undefined,
): PoseWithCovariance {
  const covariance = normalizeMatrix6(pose?.covariance as number[] | undefined);
  return { pose: normalizePose(pose?.pose), covariance };
}

function normalizePoseWithCovarianceStamped(
  message: PartialMessage<PoseWithCovarianceStamped>,
): PoseWithCovarianceStamped {
  return {
    header: normalizeHeader(message.header),
    pose: normalizePoseWithCovariance(message.pose),
  };
}
