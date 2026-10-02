import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { hashingStream } from './hashing.js';

/**
 * S3 blob store (EDRMS_STORAGE=s3). Every version has its own immutable key, so presigned URLs
 * for old versions keep working and nothing depends on bucket-native versioning. Objects are
 * written with SSE (AES256), as in cportal-be.
 *
 * Credentials: explicit keys if given, otherwise the SDK's default chain (IAM role, env, profile).
 */
export function createS3Store({ bucket, region, accessKeyId, secretAccessKey, client }) {
    if (!bucket) throw new Error('S3 store: bucket is required');
    const s3 = client || new S3Client({
        region,
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {})
    });
    return {
        kind: 's3',
        client: s3,
        async put({ key, body, contentType }) {
            const { stream, result } = hashingStream(body);
            const upload = new Upload({
                client: s3,
                params: { Bucket: bucket, Key: key, Body: stream, ContentType: contentType, ServerSideEncryption: 'AES256' }
            });
            const [hashed] = await Promise.all([result(), upload.done()]);
            return hashed;
        },
        async getStream(key) {
            const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            return res.Body;
        },
        async delete(key) {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
        async signedUrl(key, { expiresIn, fileName, contentType }) {
            const command = new GetObjectCommand({
                Bucket: bucket, Key: key,
                ResponseContentType: contentType,
                ResponseContentDisposition: `inline; filename="${fileName.replace(/"/g, '')}"`
            });
            return getSignedUrl(s3, command, { expiresIn });
        }
    };
}
