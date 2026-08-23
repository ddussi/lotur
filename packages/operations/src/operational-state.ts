export type DeploymentIdentity = Readonly<{
  deploymentId: string;
  configDigest: string;
}>;

export type CanaryStatus = "UNKNOWN" | "PASSED" | "FAILED";

export type OperationalState = Readonly<{
  identity: DeploymentIdentity;
  killSwitchEnabled: boolean;
  canaryStatus: CanaryStatus;
  canaryCheckedAt?: Date;
  admissionApprovedAt?: Date;
  admissionApprovedBy?: string;
  updatedAt: Date;
}>;

export type OperationalActor = Readonly<{
  accountId: string;
  accountAuthVersion: number;
}>;

export interface OperationalStateRepository {
  getOperationalState(identity: DeploymentIdentity): Promise<OperationalState>;
  recordCanaryResult(
    identity: DeploymentIdentity,
    result: Exclude<CanaryStatus, "UNKNOWN">,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState>;
  approveAdmission(
    identity: DeploymentIdentity,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState>;
  closeAdmission(
    identity: DeploymentIdentity,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState>;
  setKillSwitch(
    identity: DeploymentIdentity,
    enabled: boolean,
    actor: OperationalActor,
    now: Date,
  ): Promise<OperationalState>;
}

export class OperationalStateError extends Error {
  readonly code:
    | "CANARY_REQUIRED"
    | "DEPLOYMENT_IDENTITY_MISMATCH"
    | "ACTOR_NOT_AUTHORIZED";

  constructor(
    code: "CANARY_REQUIRED" | "DEPLOYMENT_IDENTITY_MISMATCH" | "ACTOR_NOT_AUTHORIZED",
    message: string,
  ) {
    super(message);
    this.name = "OperationalStateError";
    this.code = code;
  }
}

export class OperationalStateCache {
  readonly #identity: DeploymentIdentity;
  #state: OperationalState | undefined;
  #available = false;

  constructor(identity: DeploymentIdentity) {
    this.#identity = identity;
  }

  apply(state: OperationalState): void {
    if (!sameDeployment(this.#identity, state.identity)) {
      throw new OperationalStateError(
        "DEPLOYMENT_IDENTITY_MISMATCH",
        "operational state belongs to a different deployment",
      );
    }
    this.#state = state;
    this.#available = true;
  }

  markUnavailable(): void {
    this.#available = false;
  }

  snapshot(): OperationalState | undefined {
    return this.#state;
  }

  isAdmissionReady(): boolean {
    return this.#available &&
      this.#state !== undefined &&
      !this.#state.killSwitchEnabled &&
      this.#state.canaryStatus === "PASSED" &&
      this.#state.canaryCheckedAt !== undefined &&
      this.#state.admissionApprovedAt !== undefined &&
      this.#state.admissionApprovedBy !== undefined;
  }

  isKillSwitchEnabled(): boolean {
    return this.#state?.killSwitchEnabled ?? true;
  }
}

export function parseDeploymentIdentity(
  deploymentId: string,
  configDigest: string,
): DeploymentIdentity {
  if (
    deploymentId.length < 1 ||
    deploymentId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deploymentId)
  ) {
    throw new Error(
      "DEPLOYMENT_ID must contain 1-128 letters, digits, dots, underscores or hyphens",
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest)) {
    throw new Error("DEPLOYMENT_CONFIG_DIGEST must use canonical sha256:<64 lowercase hex>");
  }
  return Object.freeze({ deploymentId, configDigest });
}

export function sameDeployment(
  left: DeploymentIdentity,
  right: DeploymentIdentity,
): boolean {
  return left.deploymentId === right.deploymentId &&
    left.configDigest === right.configDigest;
}
