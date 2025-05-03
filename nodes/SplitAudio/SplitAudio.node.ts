import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

const execPromise = promisify(exec);

export class SplitAudio implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Split Audio',
		name: 'splitAudio',
		icon: 'file:splitaudio.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Splits an audio file into chunks of specified size',
		defaults: {
			name: 'Audio Split',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Split Audio',
						value: 'split',
						description: 'Split an audio file into multiple chunks',
						action: 'Split an audio file into multiple chunks',
					},
				],
				default: 'split',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
				description: 'Name of the binary property containing the audio file to split',
			},
			{
				displayName: 'Chunk Size',
				name: 'chunkSize',
				type: 'number',
				default: 10,
				required: true,
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
				description: 'Size of each chunk in MB',
			},
			{
				displayName: 'Output Prefix',
				name: 'outputPrefix',
				type: 'string',
				default: 'segment',
				required: true,
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
				description: 'Prefix for chunk filenames',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{
						name: 'Same As Input',
						value: 'same',
					},
					{
						name: 'MP3',
						value: 'mp3',
					},
					{
						name: 'M4A',
						value: 'm4a',
					},
					{
						name: 'WAV',
						value: 'wav',
					},
				],
				default: 'same',
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
				description: 'Format for output chunks',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Check if ffmpeg is installed
		try {
			await execPromise('ffmpeg -version');
		} catch (error) {
			throw new NodeOperationError(
				this.getNode(),
				'FFmpeg is required for this node to work but was not found. Please install FFmpeg.',
				{ itemIndex: 0 },
			);
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const operation = this.getNodeParameter('operation', itemIndex) as string;

			if (operation === 'split') {
				// Get parameters
				const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex) as string;
				const chunkSizeMB = this.getNodeParameter('chunkSize', itemIndex) as number;
				const outputPrefix = this.getNodeParameter('outputPrefix', itemIndex) as string;
				const outputFormat = this.getNodeParameter('outputFormat', itemIndex) as string;

				// Check if binary data exists
				if (!items[itemIndex].binary || !items[itemIndex].binary?.[binaryPropertyName]) {
					throw new NodeOperationError(
						this.getNode(),
						`No binary data property "${binaryPropertyName}" exists on item!`,
						{ itemIndex },
					);
				}

				const binaryData = items[itemIndex].binary![binaryPropertyName];
				const filePath = (binaryData.filePath ||
					(this.getNodeParameter('filePath', itemIndex, '') as string)) as string;

				if (!filePath) {
					throw new NodeOperationError(
						this.getNode(),
						'No file path available! Make sure to use a node like "Read Binary File" first.',
						{ itemIndex },
					);
				}

				try {
					// Create temp directory for output chunks
					const tmpDir = path.join(os.tmpdir(), `n8n-split-audio-${Date.now()}`);
					await fs.promises.mkdir(tmpDir, { recursive: true });

					// Get file information
					const fileInfo = path.parse(filePath);
					const fileBaseName = fileInfo.name;
					const fileExtension = fileInfo.ext.toLowerCase();

					// Determine output extension
					let outputExtension = fileExtension;
					if (outputFormat !== 'same') {
						outputExtension = `.${outputFormat}`;
					}

					// Get audio info
					const { stdout: ffprobeOutput } = await execPromise(
						`ffprobe -v error -show_entries format=duration,bit_rate -of json "${filePath}"`,
					);

					const ffprobeData = JSON.parse(ffprobeOutput);
					const duration = parseFloat(ffprobeData.format.duration);
					let bitrate = parseInt(ffprobeData.format.bit_rate);

					// Fallback if bitrate not available
					if (!bitrate) {
						const { size } = await fs.promises.stat(filePath);
						bitrate = Math.round((size * 8) / duration);
					}

					// Calculate chunk duration in seconds
					const chunkSizeBytes = chunkSizeMB * 1024 * 1024;
					let chunkDurationSeconds = (chunkSizeBytes * 8) / bitrate;

					// Ensure minimum duration
					if (chunkDurationSeconds < 1) {
						chunkDurationSeconds = 1;
					}

					// Output pattern for ffmpeg
					const outputPattern = path.join(
						tmpDir,
						`${fileBaseName}_${outputPrefix}_%03d${outputExtension}`,
					);

					// Split the file using FFmpeg segment feature
					const ffmpegCmd = `ffmpeg -i "${filePath}" -f segment -segment_time ${chunkDurationSeconds} -reset_timestamps 1 -c copy "${outputPattern}"`;
					await execPromise(ffmpegCmd);

					// Read created chunks
					const chunkFiles = (await fs.promises.readdir(tmpDir))
						.filter((file) => file.startsWith(`${fileBaseName}_${outputPrefix}_`))
						.sort();

					// Add each chunk as a separate item in the output
					for (const chunkFile of chunkFiles) {
						const chunkPath = path.join(tmpDir, chunkFile);
						const fileSize = (await fs.promises.stat(chunkPath)).size;
						const fileContent = await fs.promises.readFile(chunkPath);

						// Create binary data
						const chunk: INodeExecutionData = {
							json: {
								filename: chunkFile,
								size: fileSize,
								sizeInMB: fileSize / (1024 * 1024),
								originalFile: fileBaseName + fileExtension,
								duration: chunkDurationSeconds,
							},
							binary: {
								[binaryPropertyName]: await this.helpers.prepareBinaryData(
									fileContent,
									chunkFile,
									binaryData.mimeType,
								),
							},
						};

						returnData.push(chunk);

						// Clean up temp file
						await fs.promises.unlink(chunkPath);
					}

					// Clean up temp directory
					await fs.promises.rmdir(tmpDir);
				} catch (error) {
					if (error instanceof Error) {
						throw new NodeOperationError(
							this.getNode(),
							`Failed to split audio: ${error.message}`,
							{ itemIndex },
						);
					}
					throw error;
				}
			}
		}

		return [returnData];
	}
}
