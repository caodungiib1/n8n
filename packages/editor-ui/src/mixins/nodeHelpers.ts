import { EnableNodeToggleCommand } from './../models/history';
import { useHistoryStore } from '@/stores/history.store';
import { PLACEHOLDER_FILLED_AT_EXECUTION_TIME, CUSTOM_API_CALL_KEY } from '@/constants';

import type {
	IBinaryKeyData,
	ICredentialType,
	INodeCredentialDescription,
	INodeCredentialsDetails,
	INodeExecutionData,
	INodeIssues,
	INodeIssueObjectProperty,
	INodeParameters,
	INodeProperties,
	INodeTypeDescription,
	IRunData,
	ITaskDataConnections,
	INode,
	INodePropertyOptions,
	IDataObject,
} from 'n8n-workflow';
import { NodeHelpers } from 'n8n-workflow';

import type {
	ICredentialsResponse,
	INodeUi,
	INodeUpdatePropertiesInformation,
	IUser,
} from '@/Interface';

import { get } from 'lodash-es';

import { isObjectLiteral } from '@/utils';
import { getCredentialPermissions } from '@/permissions';
import { mapStores } from 'pinia';
import { useSettingsStore } from '@/stores/settings.store';
import { useUsersStore } from '@/stores/users.store';
import { useWorkflowsStore } from '@/stores/workflows.store';
import { useRootStore } from '@/stores';
import { useNodeTypesStore } from '@/stores/nodeTypes.store';
import { useCredentialsStore } from '@/stores/credentials.store';
import { defineComponent } from 'vue';

export const nodeHelpers = defineComponent({
	computed: {
		...mapStores(
			useCredentialsStore,
			useHistoryStore,
			useNodeTypesStore,
			useSettingsStore,
			useWorkflowsStore,
			useUsersStore,
			useRootStore,
		),
	},
	methods: {
		hasProxyAuth(node: INodeUi): boolean {
			return Object.keys(node.parameters).includes('nodeCredentialType');
		},

		isCustomApiCallSelected(nodeValues: INodeParameters): boolean {
			const { parameters } = nodeValues;

			if (!isObjectLiteral(parameters)) return false;

			return (
				(parameters.resource !== undefined && parameters.resource.includes(CUSTOM_API_CALL_KEY)) ||
				(parameters.operation !== undefined && parameters.operation.includes(CUSTOM_API_CALL_KEY))
			);
		},

		// Returns the parameter value
		getParameterValue(nodeValues: INodeParameters, parameterName: string, path: string) {
			return get(nodeValues, path ? path + '.' + parameterName : parameterName);
		},

		// Returns if the given parameter should be displayed or not
		displayParameter(
			nodeValues: INodeParameters,
			parameter: INodeProperties | INodeCredentialDescription,
			path: string,
			node: INodeUi | null,
		) {
			return NodeHelpers.displayParameterPath(nodeValues, parameter, path, node);
		},

		// Returns all the issues of the node
		getNodeIssues(
			nodeType: INodeTypeDescription | null,
			node: INodeUi,
			ignoreIssues?: string[],
		): INodeIssues | null {
			const pinDataNodeNames = Object.keys(this.workflowsStore.getPinData || {});

			let nodeIssues: INodeIssues | null = null;
			ignoreIssues = ignoreIssues || [];

			if (node.disabled === true || pinDataNodeNames.includes(node.name)) {
				// Ignore issues on disabled and pindata nodes
				return null;
			}

			if (nodeType === null) {
				// Node type is not known
				if (!ignoreIssues.includes('typeUnknown')) {
					nodeIssues = {
						typeUnknown: true,
					};
				}
			} else {
				// Node type is known

				// Add potential parameter issues
				if (!ignoreIssues.includes('parameters')) {
					nodeIssues = NodeHelpers.getNodeParametersIssues(nodeType.properties, node);
				}

				if (!ignoreIssues.includes('credentials')) {
					// Add potential credential issues
					const nodeCredentialIssues = this.getNodeCredentialIssues(node, nodeType);
					if (nodeIssues === null) {
						nodeIssues = nodeCredentialIssues;
					} else {
						NodeHelpers.mergeIssues(nodeIssues, nodeCredentialIssues);
					}
				}
			}

			if (this.hasNodeExecutionIssues(node) === true && !ignoreIssues.includes('execution')) {
				if (nodeIssues === null) {
					nodeIssues = {};
				}
				nodeIssues.execution = true;
			}

			return nodeIssues;
		},

		// Set the status on all the nodes which produced an error so that it can be
		// displayed in the node-view
		hasNodeExecutionIssues(node: INodeUi): boolean {
			const workflowResultData = this.workflowsStore.getWorkflowRunData;

			if (workflowResultData === null || !workflowResultData.hasOwnProperty(node.name)) {
				return false;
			}

			for (const taskData of workflowResultData[node.name]) {
				if (taskData.error !== undefined) {
					return true;
				}
			}

			return false;
		},

		reportUnsetCredential(credentialType: ICredentialType) {
			return {
				credentials: {
					[credentialType.name]: [
						this.$locale.baseText('nodeHelpers.credentialsUnset', {
							interpolate: {
								credentialType: credentialType.displayName,
							},
						}),
					],
				},
			};
		},

		// Updates the execution issues.
		updateNodesExecutionIssues() {
			const nodes = this.workflowsStore.allNodes;

			for (const node of nodes) {
				this.workflowsStore.setNodeIssue({
					node: node.name,
					type: 'execution',
					value: this.hasNodeExecutionIssues(node) ? true : null,
				});
			}
		},

		// Updates the credential-issues of the node
		updateNodeCredentialIssues(node: INodeUi): void {
			const fullNodeIssues: INodeIssues | null = this.getNodeCredentialIssues(node);

			let newIssues: INodeIssueObjectProperty | null = null;
			if (fullNodeIssues !== null) {
				newIssues = fullNodeIssues.credentials!;
			}

			this.workflowsStore.setNodeIssue({
				node: node.name,
				type: 'credentials',
				value: newIssues,
			});
		},

		// Updates the parameter-issues of the node
		updateNodeParameterIssues(node: INodeUi, nodeType?: INodeTypeDescription): void {
			if (nodeType === undefined) {
				nodeType = this.nodeTypesStore.getNodeType(node.type, node.typeVersion);
			}

			if (nodeType === null) {
				// Could not find nodeType so can not update issues
				return;
			}

			// All data got updated everywhere so update now the issues
			const fullNodeIssues: INodeIssues | null = NodeHelpers.getNodeParametersIssues(
				nodeType!.properties,
				node,
			);

			let newIssues: INodeIssueObjectProperty | null = null;
			if (fullNodeIssues !== null) {
				newIssues = fullNodeIssues.parameters!;
			}

			this.workflowsStore.setNodeIssue({
				node: node.name,
				type: 'parameters',
				value: newIssues,
			});
		},

		// Returns all the credential-issues of the node
		getNodeCredentialIssues(node: INodeUi, nodeType?: INodeTypeDescription): INodeIssues | null {
			if (node.disabled) {
				// Node is disabled
				return null;
			}

			if (!nodeType) {
				nodeType = this.nodeTypesStore.getNodeType(node.type, node.typeVersion);
			}

			if (!nodeType?.credentials) {
				// Node does not need any credentials or nodeType could not be found
				return null;
			}

			const foundIssues: INodeIssueObjectProperty = {};

			let userCredentials: ICredentialsResponse[] | null;
			let credentialType: ICredentialType | null;
			let credentialDisplayName: string;
			let selectedCredentials: INodeCredentialsDetails;

			const { authentication, genericAuthType, nodeCredentialType } =
				node.parameters as HttpRequestNode.V2.AuthParams;

			if (
				authentication === 'genericCredentialType' &&
				genericAuthType !== '' &&
				selectedCredsAreUnusable(node, genericAuthType)
			) {
				const credential = this.credentialsStore.getCredentialTypeByName(genericAuthType);
				return this.reportUnsetCredential(credential);
			}

			if (
				this.hasProxyAuth(node) &&
				authentication === 'predefinedCredentialType' &&
				nodeCredentialType !== '' &&
				node.credentials !== undefined
			) {
				const stored = this.credentialsStore.getCredentialsByType(nodeCredentialType);

				if (selectedCredsDoNotExist(node, nodeCredentialType, stored)) {
					const credential = this.credentialsStore.getCredentialTypeByName(nodeCredentialType);
					return this.reportUnsetCredential(credential);
				}
			}

			if (
				this.hasProxyAuth(node) &&
				authentication === 'predefinedCredentialType' &&
				nodeCredentialType !== '' &&
				selectedCredsAreUnusable(node, nodeCredentialType)
			) {
				const credential = this.credentialsStore.getCredentialTypeByName(nodeCredentialType);
				return this.reportUnsetCredential(credential);
			}

			for (const credentialTypeDescription of nodeType.credentials) {
				// Check if credentials should be displayed else ignore
				if (!this.displayParameter(node.parameters, credentialTypeDescription, '', node)) {
					continue;
				}

				// Get the display name of the credential type
				credentialType = this.credentialsStore.getCredentialTypeByName(
					credentialTypeDescription.name,
				);
				if (credentialType === null) {
					credentialDisplayName = credentialTypeDescription.name;
				} else {
					credentialDisplayName = credentialType.displayName;
				}

				if (!node.credentials || !node.credentials?.[credentialTypeDescription.name]) {
					// Credentials are not set
					if (credentialTypeDescription.required) {
						foundIssues[credentialTypeDescription.name] = [
							this.$locale.baseText('nodeIssues.credentials.notSet', {
								interpolate: { type: nodeType.displayName },
							}),
						];
					}
				} else {
					// If they are set check if the value is valid
					selectedCredentials = node.credentials[
						credentialTypeDescription.name
					] as INodeCredentialsDetails;
					if (typeof selectedCredentials === 'string') {
						selectedCredentials = {
							id: null,
							name: selectedCredentials,
						};
					}

					const usersStore = useUsersStore();
					const currentUser = usersStore.currentUser || ({} as IUser);
					userCredentials = this.credentialsStore
						.getCredentialsByType(credentialTypeDescription.name)
						.filter((credential: ICredentialsResponse) => {
							const permissions = getCredentialPermissions(currentUser, credential);
							return permissions.use;
						});

					if (userCredentials === null) {
						userCredentials = [];
					}

					if (selectedCredentials.id) {
						const idMatch = userCredentials.find(
							(credentialData) => credentialData.id === selectedCredentials.id,
						);
						if (idMatch) {
							continue;
						}
					}

					const nameMatches = userCredentials.filter(
						(credentialData) => credentialData.name === selectedCredentials.name,
					);
					if (nameMatches.length > 1) {
						foundIssues[credentialTypeDescription.name] = [
							this.$locale.baseText('nodeIssues.credentials.notIdentified', {
								interpolate: { name: selectedCredentials.name, type: credentialDisplayName },
							}),
							this.$locale.baseText('nodeIssues.credentials.notIdentified.hint'),
						];
						continue;
					}

					if (nameMatches.length === 0) {
						const isInstanceOwner = this.usersStore.isInstanceOwner;
						const isCredentialUsedInWorkflow =
							this.workflowsStore.usedCredentials?.[selectedCredentials.id as string];
						if (!isCredentialUsedInWorkflow && !isInstanceOwner) {
							foundIssues[credentialTypeDescription.name] = [
								this.$locale.baseText('nodeIssues.credentials.doNotExist', {
									interpolate: { name: selectedCredentials.name, type: credentialDisplayName },
								}),
								this.$locale.baseText('nodeIssues.credentials.doNotExist.hint'),
							];
						}
					}
				}
			}

			// TODO: Could later check also if the node has access to the credentials
			if (Object.keys(foundIssues).length === 0) {
				return null;
			}

			return {
				credentials: foundIssues,
			};
		},

		// Updates the node credential issues
		updateNodesCredentialsIssues() {
			const nodes = this.workflowsStore.allNodes;
			let issues: INodeIssues | null;

			for (const node of nodes) {
				issues = this.getNodeCredentialIssues(node);

				this.workflowsStore.setNodeIssue({
					node: node.name,
					type: 'credentials',
					value: issues === null ? null : issues.credentials,
				});
			}
		},

		getNodeInputData(node: INodeUi | null, runIndex = 0, outputIndex = 0): INodeExecutionData[] {
			if (node === null) {
				return [];
			}

			if (this.workflowsStore.getWorkflowExecution === null) {
				return [];
			}
			const executionData = this.workflowsStore.getWorkflowExecution.data;
			if (!executionData || !executionData.resultData) {
				// unknown status
				return [];
			}
			const runData = executionData.resultData.runData;

			if (
				runData === null ||
				runData[node.name] === undefined ||
				!runData[node.name][runIndex].data ||
				runData[node.name][runIndex].data === undefined
			) {
				return [];
			}

			return this.getMainInputData(runData[node.name][runIndex].data!, outputIndex);
		},

		// Returns the data of the main input
		getMainInputData(
			connectionsData: ITaskDataConnections,
			outputIndex: number,
		): INodeExecutionData[] {
			if (
				!connectionsData ||
				!connectionsData.hasOwnProperty('main') ||
				connectionsData.main === undefined ||
				connectionsData.main.length < outputIndex ||
				connectionsData.main[outputIndex] === null
			) {
				return [];
			}
			return connectionsData.main[outputIndex] as INodeExecutionData[];
		},

		// Returns all the binary data of all the entries
		getBinaryData(
			workflowRunData: IRunData | null,
			node: string | null,
			runIndex: number,
			outputIndex: number,
		): IBinaryKeyData[] {
			if (node === null) {
				return [];
			}

			const runData: IRunData | null = workflowRunData;

			if (
				runData === null ||
				!runData[node] ||
				!runData[node][runIndex] ||
				!runData[node][runIndex].data
			) {
				return [];
			}

			const inputData = this.getMainInputData(runData[node][runIndex].data!, outputIndex);

			const returnData: IBinaryKeyData[] = [];
			for (let i = 0; i < inputData.length; i++) {
				if (inputData[i].hasOwnProperty('binary') && inputData[i].binary !== undefined) {
					returnData.push(inputData[i].binary!);
				}
			}

			return returnData;
		},

		disableNodes(nodes: INodeUi[], trackHistory = false) {
			if (trackHistory) {
				this.historyStore.startRecordingUndo();
			}
			for (const node of nodes) {
				const oldState = node.disabled;
				// Toggle disabled flag
				const updateInformation = {
					name: node.name,
					properties: {
						disabled: !oldState,
					} as IDataObject,
				} as INodeUpdatePropertiesInformation;

				this.$telemetry.track('User set node enabled status', {
					node_type: node.type,
					is_enabled: node.disabled,
					workflow_id: this.workflowsStore.workflowId,
				});

				this.workflowsStore.updateNodeProperties(updateInformation);
				this.workflowsStore.clearNodeExecutionData(node.name);
				this.updateNodeParameterIssues(node);
				this.updateNodeCredentialIssues(node);
				if (trackHistory) {
					this.historyStore.pushCommandToUndo(
						new EnableNodeToggleCommand(node.name, oldState === true, node.disabled === true),
					);
				}
			}
			if (trackHistory) {
				this.historyStore.stopRecordingUndo();
			}
		},
		// @ts-ignore
		getNodeSubtitle(data, nodeType, workflow): string | undefined {
			if (!data) {
				return undefined;
			}

			if (data.notesInFlow) {
				return data.notes;
			}

			if (nodeType !== null && nodeType.subtitle !== undefined) {
				try {
					return workflow.expression.getSimpleParameterValue(
						data as INode,
						nodeType.subtitle,
						'internal',
						this.rootStore.timezone,
						{},
						undefined,
						PLACEHOLDER_FILLED_AT_EXECUTION_TIME,
					) as string | undefined;
				} catch (e) {
					return undefined;
				}
			}

			if (data.parameters.operation !== undefined) {
				const operation = data.parameters.operation as string;
				if (nodeType === null) {
					return operation;
				}

				const operationData: INodeProperties = nodeType.properties.find(
					(property: INodeProperties) => {
						return property.name === 'operation';
					},
				);
				if (operationData === undefined) {
					return operation;
				}

				if (operationData.options === undefined) {
					return operation;
				}

				const optionData = operationData.options.find((option) => {
					return (option as INodePropertyOptions).value === data.parameters.operation;
				});
				if (optionData === undefined) {
					return operation;
				}

				return optionData.name;
			}
			return undefined;
		},
	},
});

/**
 * Whether the node has no selected credentials, or none of the node's
 * selected credentials are of the specified type.
 */
function selectedCredsAreUnusable(node: INodeUi, credentialType: string) {
	return !node.credentials || !Object.keys(node.credentials).includes(credentialType);
}

/**
 * Whether the node's selected credentials of the specified type
 * can no longer be found in the database.
 */
function selectedCredsDoNotExist(
	node: INodeUi,
	nodeCredentialType: string,
	storedCredsByType: ICredentialsResponse[] | null,
) {
	if (!node.credentials || !storedCredsByType) return false;

	const selectedCredsByType = node.credentials[nodeCredentialType];

	if (!selectedCredsByType) return false;

	return !storedCredsByType.find((c) => c.id === selectedCredsByType.id);
}

declare namespace HttpRequestNode {
	namespace V2 {
		type AuthParams = {
			authentication: 'none' | 'genericCredentialType' | 'predefinedCredentialType';
			genericAuthType: string;
			nodeCredentialType: string;
		};
	}
}
