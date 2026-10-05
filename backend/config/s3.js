import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';

dotenv.config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

export const uploadToS3 = async ({ buffer, originalName, mimetype, folder = 'company-assets', type = 'general' }) => {
  if (!process.env.AWS_BUCKET_NAME) {
    throw new Error('Missing AWS S3 bucket configuration');
  }

  const safeFileName = `${Date.now()}-${String(originalName || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const key = `${folder}/${type}/${safeFileName}`;

  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype || 'application/octet-stream',
  }));

  const url = await getSignedUrlForKey(key);

  return {
    key,
    public_id: key,
    url,
  };
};

export const getSignedUrlForKey = async (key) => {
  if (!key || !process.env.AWS_BUCKET_NAME) {
    return '';
  }

  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    }),
    { expiresIn: 60 * 60 * 24 }
  );
};

export const deleteFromS3 = async ({ key, public_id }) => {
  const objectKey = key || public_id;

  if (!objectKey) {
    return;
  }

  await s3Client.send(new DeleteObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: objectKey,
  }));
};

export default s3Client;
