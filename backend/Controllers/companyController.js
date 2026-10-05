import Company from '../models/Company.js';
import { uploadToS3, deleteFromS3, getSignedUrlForKey } from '../config/s3.js';

const companyWithSignedAssetUrls = async (company) => {
  await Company.updateOne(
    { _id: company._id },
    { $unset: { 'logo.url': '', 'signature.url': '' } }
  );

  const data = company.toObject();
  for (const type of ['logo', 'signature']) {
    const key = data[type]?.public_id || '';
    data[type] = {
      public_id: key,
      url: await getSignedUrlForKey(key),
    };
  }
  return data;
};
 
//get company info
export const getCompany = async (req, res) => {
  try {
    const company = await Company.findOne();
    if (!company) {
      return res.json({
        success: true,
        message: "No company info found",
        data: {},
      });
    }
    res.json({ success: true, data: await companyWithSignedAssetUrls(company) });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching company information",
      error: error.message,
    });
  }
};
 
//put company info (Update or Create)
 
export const updateCompany = async (req, res) => {
  try {
    const {
      companyName,
      address,
      phone,
      email,
      gstNumber: gstNumber,
      currency,
      website,
      fiscalYear,
      accountNo,
      accountName,
      bank,
      ifsc,
      accountType
    } = req.body;
 
    if (!address) {
      return res
        .status(400)
        .json({ success: false, message: "Company address is required" });
    }
 
    let company = await Company.findOne();
 
    if (company) {
      company.companyName = companyName || company.companyName;
      company.address = address;
      company.phone = phone;
      company.email = email;
      company.gstNumber = gstNumber;
      company.currency = currency;
      company.website = website;
      company.fiscalYear = fiscalYear;
      company.accountNo = accountNo;
      company.accountName = accountName;
      company.bank = bank;
      company.ifsc = ifsc;
      company.accountType = accountType;
      await company.save();
    } else {
      company = await Company.create({
        companyName,
        address,
        phone,
        email,
        gstNumber: gstNumber,
        currency,
        website,
        fiscalYear,
        accountNo,
        accountName,
        bank,
        ifsc,
        accountType
      });
    }
 
    res.json({
      success: true,
      message: "Company information updated successfully",
      data: await companyWithSignedAssetUrls(company),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating company information",
      error: error.message,
    });
  }
};
 
export const uploadImage = async (req, res) => {
  try {
    console.log('Upload image request received:', {
      type: req.body.type,
      file: req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        buffer: req.file.buffer ? `Buffer present (${req.file.buffer.length} bytes)` : 'No buffer'
      } : 'No file'
    });
 
    const { type } = req.body; // 'logo' or 'signature'
   
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No image file provided"
      });
    }
 
    if (!['logo', 'signature'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid image type. Must be 'logo' or 'signature'"
      });
    }
 
    // Check if buffer exists
    if (!req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: "File buffer is missing. Please try uploading again."
      });
    }

    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_BUCKET_NAME || !process.env.AWS_REGION) {
      console.error('Missing AWS S3 configuration:', {
        AWS_ACCESS_KEY_ID: !!process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: !!process.env.AWS_SECRET_ACCESS_KEY,
        AWS_BUCKET_NAME: !!process.env.AWS_BUCKET_NAME,
        AWS_REGION: !!process.env.AWS_REGION
      });
      return res.status(500).json({
        success: false,
        message: "Server configuration error: Missing Amazon S3 credentials"
      });
    }
 
    let company = await Company.findOne();
    if (!company) {
      company = await Company.create({});
    }
 
    if (company[type]?.public_id) {
      try {
        await deleteFromS3({ public_id: company[type].public_id });
        console.log(`Deleted old ${type} image: ${company[type].public_id}`);
      } catch (deleteError) {
        console.warn(`Could not delete old ${type} image:`, deleteError.message);
      }
    }
 
    console.log('Uploading image to Amazon S3...');
    const result = await uploadToS3({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      folder: 'company-assets',
      type,
    });
   
    console.log('Amazon S3 upload successful:', {
      key: result.key,
    });
 
    company[type] = {
      public_id: result.key,
    };
 
    await company.save();
 
    res.json({
      success: true,
      message: `${type.charAt(0).toUpperCase() + type.slice(1)} uploaded successfully`,
      data: await companyWithSignedAssetUrls(company)
    });
  } catch (error) {
    console.error('❌ Error in uploadImage:', error);
   
    // More specific error messages
    let errorMessage = "Error uploading image";
    if (error.message.includes('timeout')) {
      errorMessage = "Upload timeout. Please try again.";
    } else if (error.message.includes('credentials') || error.message.includes('Invalid credentials') || error.message.includes('AccessDenied')) {
      errorMessage = "Amazon S3 authentication failed. Please verify AWS credentials in environment variables.";
    } else if (error.message.includes('NoSuchBucket') || error.message.includes('bucket')) {
      errorMessage = "Amazon S3 bucket is not configured correctly.";
    } else if (error.name === 'RequestTimeoutError' || error.message.includes('ETIMEDOUT')) {
      errorMessage = "Connection timeout to Amazon S3. Please check your network connection.";
    }
 
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      debugInfo: process.env.NODE_ENV === 'development' ? {
        errorType: error.constructor.name,
        http_code: error.http_code
      } : undefined
    });
  }
};
 
export const deleteImage = async (req, res) => {
  try {
    const { type } = req.params;
 
    if (!['logo', 'signature'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid image type"
      });
    }
 
    let company = await Company.findOne();
    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Company not found"
      });
    }
 
    if (company[type]?.public_id) {
      await deleteFromS3({ public_id: company[type].public_id });
    }
 
    // Remove image reference from company
    company[type] = { public_id: '' };
    await company.save();
 
    res.json({
      success: true,
      message: `${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully`,
      data: await companyWithSignedAssetUrls(company)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting image",
      error: error.message
    });
  }
};
 