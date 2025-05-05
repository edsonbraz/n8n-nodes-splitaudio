import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
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
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				options: [
					{
						name: 'Binary Data',
						value: 'binaryData',
						description: 'Use binary data from an input field',
					},
					{
						name: 'File Path',
						value: 'filePath',
						description:
							'Use a file path from a previous node (e.g., Google Drive, Read/Write Files)',
					},
				],
				default: 'binaryData',
				description: 'Whether to use binary data or a file path as input',
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
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
						inputType: ['binaryData'],
					},
				},
				description: 'Name of the binary property containing the audio file to split',
			},
			{
				displayName: 'File Path Field',
				name: 'filePathField',
				type: 'string',
				default: 'fileName',
				required: true,
				placeholder: 'fileName',
				displayOptions: {
					show: {
						operation: ['split'],
						inputType: ['filePath'],
					},
				},
				description:
					'Name of the JSON property containing the file path (usually fileName from Read/Write Files from Disk node)',
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
			{
				displayName: 'Delete Original File After Processing',
				name: 'deleteOriginal',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						operation: ['split'],
						inputType: ['filePath'],
					},
				},
				description: 'Whether to delete the original file after successful processing',
			},
			{
				displayName: 'Memory Management',
				name: 'memoryManagement',
				type: 'options',
				options: [
					{
						name: 'Standard',
						value: 'standard',
						description: 'Default memory usage',
					},
					{
						name: 'Low Memory',
						value: 'lowMemory',
						description: 'Process files with minimal memory usage (slower but uses less RAM)',
					},
				],
				default: 'standard',
				displayOptions: {
					show: {
						operation: ['split'],
					},
				},
				description: 'How to handle memory usage during processing',
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
				const inputType = this.getNodeParameter('inputType', itemIndex) as string;
				const chunkSizeMB = this.getNodeParameter('chunkSize', itemIndex) as number;
				const outputPrefix = this.getNodeParameter('outputPrefix', itemIndex) as string;
				const outputFormat = this.getNodeParameter('outputFormat', itemIndex) as string;

				// Get additional parameters
				const memoryManagement = this.getNodeParameter('memoryManagement', itemIndex) as string;
				const deleteOriginal =
					inputType === 'filePath'
						? (this.getNodeParameter('deleteOriginal', itemIndex) as boolean)
						: false;

				// Track if this is a user-provided file that needs to be deleted (not a temp file)
				const isUserProvidedFile = inputType === 'filePath';

				// Get the path to the input file
				let filePath = '';
				let binaryData = undefined;
				let mimeType = '';

				if (inputType === 'binaryData') {
					const binaryPropertyName = this.getNodeParameter(
						'binaryPropertyName',
						itemIndex,
					) as string;

					// Check if binary data exists
					if (!items[itemIndex].binary || !items[itemIndex].binary?.[binaryPropertyName]) {
						throw new NodeOperationError(
							this.getNode(),
							`No binary data property "${binaryPropertyName}" exists on item!`,
							{ itemIndex },
						);
					}

					binaryData = items[itemIndex].binary![binaryPropertyName];
					mimeType = binaryData.mimeType;

					// Check if file is stored in a temporary file already
					if (
						binaryData.fileName &&
						binaryData.mimeType &&
						binaryData.data === undefined &&
						binaryData.filePath
					) {
						// If we have a file path, we can use that directly
						filePath =
							typeof binaryData.filePath === 'string'
								? binaryData.filePath
								: String(binaryData.filePath);
					} else if (binaryData.data) {
						// We need to write the base64 data to a temporary file
						const tempPrefix = `n8n-audio-split-${Date.now()}-`;
						const tempDir = os.tmpdir();
						const tempFile = path.join(
							tempDir,
							`${tempPrefix}${binaryData.fileName || 'input.mp3'}`,
						);

						// Write buffer to file
						const buffer = Buffer.from(binaryData.data, 'base64');
						await fs.promises.writeFile(tempFile, buffer);
						filePath = tempFile;
					} else {
						throw new NodeOperationError(
							this.getNode(),
							'No usable binary data found! The data must either be stored in a file or as base64 data.',
							{ itemIndex },
						);
					}
				} else if (inputType === 'filePath') {
					const filePathField = this.getNodeParameter('filePathField', itemIndex) as string;

					// Check if the value looks like a direct path (starts with / or contains : for Windows paths)
					const fieldValue = items[itemIndex].json?.[filePathField];
					const directPath =
						items[itemIndex].json &&
						typeof filePathField === 'string' &&
						(filePathField.startsWith('/') || filePathField.includes(':\\'));

					if (directPath) {
						// If the field name itself looks like a path, use it directly
						filePath = filePathField;
						this.logger.debug(`Using field name as direct path: ${filePath}`);
					} else if (fieldValue) {
						// Use the value from the specified field
						filePath = fieldValue as string;
						this.logger.debug(`Using value from field ${filePathField}: ${filePath}`);
					} else {
						throw new NodeOperationError(
							this.getNode(),
							`No file path found in the property "${filePathField}"!`,
							{ itemIndex },
						);
					}

					// Check if the file exists
					try {
						await fs.promises.access(filePath, fs.constants.R_OK);
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							`Cannot access file at path: ${filePath}. Please make sure the file exists and is readable.`,
							{ itemIndex },
						);
					}
				} else {
					throw new NodeOperationError(
						this.getNode(),
						'Invalid input type. Please select either Binary Data or File Path.',
						{ itemIndex },
					);
				}

				if (!filePath) {
					throw new NodeOperationError(
						this.getNode(),
						'Could not determine file path! Make sure to use a node like "Read Binary File" or "Read/Write Files from Disk" first.',
						{ itemIndex },
					);
				}

				try {
					// Track files to clean up at the end
					const tempFilesToCleanup: string[] = [];
					let shouldCleanupInputFile = false;

					// If we created a temp file from binary data, we should clean it up
					if (filePath && inputType === 'binaryData' && binaryData?.data !== undefined) {
						tempFilesToCleanup.push(filePath);
						shouldCleanupInputFile = true;
					}

					// Create temp directory for output chunks
					const tmpDir = path.join(os.tmpdir(), `n8n-split-audio-${Date.now()}`);
					await fs.promises.mkdir(tmpDir, { recursive: true });

					// Get file information
					const fileInfo = path.parse(filePath);
					const fileBaseName = fileInfo.name;
					const fileExtension = fileInfo.ext.toLowerCase();

					this.logger.debug(`Splitting audio file: ${filePath}`);
					this.logger.debug(`Output directory: ${tmpDir}`);
					this.logger.debug(`File info: ${JSON.stringify(fileInfo)}`);

					// Determine output extension
					let outputExtension = fileExtension;
					if (outputFormat !== 'same') {
						outputExtension = `.${outputFormat}`;
					}

					// Get audio info using ffprobe via fluent-ffmpeg
					const getMediaInfo = () => {
						return new Promise<{ duration: number; bitrate: number }>((resolve, reject) => {
							ffmpeg.ffprobe(filePath, (err, metadata) => {
								if (err) {
									return reject(err);
								}

								const duration = metadata.format.duration || 0;
								let bitrate = metadata.format.bit_rate
									? parseInt(String(metadata.format.bit_rate))
									: 0;

								// Fallback if bitrate not available
								if (!bitrate) {
									try {
										const size = fs.statSync(filePath).size;
										bitrate = Math.round((size * 8) / duration);
									} catch (e) {
										return reject(e);
									}
								}

								resolve({ duration, bitrate });
							});
						});
					};

					const { bitrate } = await getMediaInfo();

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

					// Split the file using fluent-ffmpeg with memory management settings
					await new Promise<void>((resolve, reject) => {
						const ffmpegCommand = ffmpeg(filePath)
							.outputOptions([
								`-f segment`,
								`-segment_time ${chunkDurationSeconds}`,
								`-reset_timestamps 1`,
							])
							.outputOption('-c copy');

						// Apply low memory settings if selected
						if (memoryManagement === 'lowMemory') {
							// Add settings to reduce memory usage
							ffmpegCommand.outputOptions([
								'-max_muxing_queue_size 1024', // Lower muxing queue size
								'-nostdin', // Disable stdin to prevent buffer accumulation
							]);

							this.logger.debug('Using low memory settings for FFmpeg processing');
						}

						ffmpegCommand
							.output(outputPattern)
							.on('progress', (progress) => {
								if (progress && progress.percent) {
									this.logger.debug(`Processing: ${Math.round(progress.percent)}% done`);
								}
							})
							.on('end', () => resolve())
							.on('error', (err: Error) => reject(new Error(`FFmpeg error: ${err.message}`)))
							.run();
					});

					// Read created chunks
					const chunkFiles = (await fs.promises.readdir(tmpDir))
						.filter((file) => file.startsWith(`${fileBaseName}_${outputPrefix}_`))
						.sort();

					// Add each chunk as a separate item in the output
					for (const chunkFile of chunkFiles) {
						const chunkPath = path.join(tmpDir, chunkFile);
						const fileSize = (await fs.promises.stat(chunkPath)).size;

						let fileContent;
						// Use streaming approach for low memory mode to reduce memory footprint
						if (memoryManagement === 'lowMemory') {
							// Create read stream instead of loading entire file into memory
							// This handles binary data in smaller chunks
							const createBinaryDataFromStream = async () => {
								return new Promise<Buffer>((resolve, reject) => {
									const readStream = fs.createReadStream(chunkPath);
									const chunks: Buffer[] = [];

									readStream.on('data', (chunk) => {
										// Ensure chunk is a Buffer
										chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
									});

									readStream.on('end', () => {
										// Only concatenate at the end to minimize memory usage
										const buffer = Buffer.concat(chunks);
										resolve(buffer);
									});

									readStream.on('error', (err) => {
										reject(err);
									});
								});
							};

							// Prepare binary data using streaming approach
							const chunk: INodeExecutionData = {
								json: {
									filename: chunkFile,
									size: fileSize,
									sizeInMB: fileSize / (1024 * 1024),
									originalFile: fileBaseName + fileExtension,
									duration: chunkDurationSeconds,
								},
								binary: {
									data: await this.helpers.prepareBinaryData(
										await createBinaryDataFromStream(),
										chunkFile,
										mimeType,
									),
								},
							};

							returnData.push(chunk);
						} else {
							// Standard approach - read entire file into memory at once
							fileContent = await fs.promises.readFile(chunkPath);

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
									data: await this.helpers.prepareBinaryData(fileContent, chunkFile, mimeType),
								},
							};

							returnData.push(chunk);
						}

						// Clean up temp file
						tempFilesToCleanup.push(chunkPath);
					}

					// Clean up temp directory
					tempFilesToCleanup.push(tmpDir);

					// Cleanup all temporary files
					for (const tempFile of tempFilesToCleanup) {
						try {
							const stats = await fs.promises.stat(tempFile);
							if (stats.isDirectory()) {
								await fs.promises.rmdir(tempFile, { recursive: true });
							} else {
								await fs.promises.unlink(tempFile);
							}
						} catch (cleanupError) {
							this.logger.warn(`Failed to clean up temporary file: ${tempFile}`);
						}
					}

					// Cleanup input file based on settings
					if (shouldCleanupInputFile || (isUserProvidedFile && deleteOriginal)) {
						try {
							await fs.promises.unlink(filePath);
							this.logger.info(`Successfully deleted the original file: ${filePath}`);
						} catch (cleanupError) {
							this.logger.warn(
								`Failed to clean up file: ${filePath} - ${(cleanupError as Error).message}`,
							);
						}
					} else if (isUserProvidedFile && deleteOriginal === false) {
						this.logger.debug(`Original file ${filePath} was not deleted as per user settings`);
					}
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
