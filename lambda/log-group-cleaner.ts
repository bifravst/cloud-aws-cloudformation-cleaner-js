import {
	CloudWatchLogsClient,
	DeleteLogGroupCommand,
	DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { fromEnv } from '@nordicsemiconductor/from-env'

const AGE_IN_HOURS = parseInt(process.env.AGE_IN_HOURS ?? '24', 10)
const LOGFILE_LIMIT = parseInt(process.env.LOGFILE_LIMIT ?? '100', 10)

const logs = new CloudWatchLogsClient({})
const ssm = new SSMClient({})

const { logGroupNameRegExpParamName } = fromEnv({
	logGroupNameRegExpParamName: 'LOG_GROUP_NAME_REGEX_PARAMETER_NAME',
})(process.env)

const logGroupNameRegExpPromise = (async () => {
	const res = await ssm.send(
		new GetParameterCommand({
			Name: logGroupNameRegExpParamName,
		}),
	)

	return new RegExp(res.Parameter?.Value ?? /^asset-tracker-/)
})()

/**
 * Recursively find log groups to delete
 */
const findLogGroupsToDelete = async (
	limit = 100,
	logGroupsToDelete: string[] = [],
	startToken?: string,
): Promise<string[]> => {
	if (logGroupsToDelete.length >= limit) return logGroupsToDelete
	const { logGroups, nextToken } = await logs.send(
		new DescribeLogGroupsCommand({
			limit: 50,
			nextToken: startToken,
		}),
	)

	const logGroupNameRegExp = await logGroupNameRegExpPromise

	if (logGroups !== undefined) {
		const foundLogGroupsToDelete: string[] = logGroups
			.filter(({ logGroupName }) => logGroupNameRegExp.test(logGroupName ?? ''))
			.filter(
				({ creationTime }) =>
					Date.now() - (creationTime ?? Date.now()) >
					AGE_IN_HOURS * 60 * 60 * 100,
			)
			.map(({ logGroupName }) => logGroupName as string)

		// Log ignored log groups
		const ignoredLogGroups = logGroups
			?.filter(
				({ logGroupName }) =>
					!foundLogGroupsToDelete.includes(logGroupName ?? ''),
			)
			.map(({ logGroupName }) => logGroupName)
		ignoredLogGroups?.forEach((name) => console.log(`Ignored: ${name}`))
		logGroupsToDelete.push(...foundLogGroupsToDelete)
	}
	if (nextToken !== undefined && nextToken !== null)
		return findLogGroupsToDelete(limit, logGroupsToDelete, nextToken)
	return logGroupsToDelete
}

export const handler = async (): Promise<void> => {
	// Find old log groups to delete
	const logGroupsToDelete = await findLogGroupsToDelete(LOGFILE_LIMIT)
	await logGroupsToDelete.reduce(
		async (promise, logGroupName) =>
			promise.then(async () => {
				try {
					console.log(`Deleting log group: ${logGroupName}`)
					await logs.send(
						new DeleteLogGroupCommand({
							logGroupName: logGroupName,
						}),
					)
				} catch (err) {
					console.debug(
						`Failed to delete log group ${logGroupName}: ${
							(err as Error).message
						}`,
					)
				}
			}),
		Promise.resolve(),
	)
}
