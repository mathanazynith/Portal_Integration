import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import Customer from '../models/Customer.js';
import Invoice from '../models/Invoice.js'
import Company from '../models/Company.js';
import Transaction from '../models/Transaction.js';
import pkg from "number-to-words";
import axios from "axios";
import ExcelJS from "exceljs";
import { uploadToS3, deleteFromS3, getSignedUrlForKey } from '../config/s3.js';

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const { toWords } = pkg;

// Properly define __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads/payment-proofs');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Generate dynamic Invoice PDF - FIXED CURRENCY FOR INR
const getCurrencySymbol = (currency) => {
  const currencySymbols = {
    USD: '$',
    EUR: '€',
    INR: 'Rs. '
  };
  return currencySymbols[currency] || '$';
};

// Fixed amount in words function for INR
const getAmountInWords = (amount, currency) => {
  try {
    const amountInWords = toWords(Math.round(amount));

    // Convert to Title Case (Camel-style words)
    const camelCaseWords = amountInWords.replace(/\w\S*/g,
      txt => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase()
    );

    // Handle different currency names
    if (currency === 'INR') {
      return `${camelCaseWords} Rupees Only`;
    } else if (currency === 'EUR') {
      return `${camelCaseWords} Euros Only`;
    } else {
      return `${camelCaseWords} Dollars Only`;
    }

  } catch (error) {
    console.error("Error converting amount to words:", error);

    if (currency === 'INR') {
      return `${amount} Rupees Only`;
    } else if (currency === 'EUR') {
      return `${amount} Euros Only`;
    } else {
      return `${amount} Dollars Only`;
    }
  }
};


// Get invoice download URL for email attachment
export const getInvoiceDownloadUrl = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    console.log('📧 Generating download URL for invoice:', invoiceId);

    // Get invoice data
    const invoice = await Invoice.findById(invoiceId).populate("customerId");
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Return the PDF download URL
    const downloadUrl = `${req.protocol}://${req.get('host')}/api/invoices/${invoiceId}/download`;
    const fileName = `Invoice-${invoice.invoiceNumber || invoiceId}.pdf`;
    
    console.log('✅ Generated download URL:', { downloadUrl, fileName });

    res.json({
      success: true,
      downloadUrl: downloadUrl,
      fileName: fileName,
      invoiceNumber: invoice.invoiceNumber
    });

  } catch (error) {
    console.error('❌ Error generating download URL:', error);
    res.status(500).json({ 
      error: 'Failed to generate download URL', 
      details: error.message 
    });
  }
};


// Format currency amount based on currency type
const formatCurrencyAmount = (amount, currency) => {
  if (currency === 'INR') {
    // Indian numbering system - comma after hundreds, thousands, etc.
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } else {
    // Western numbering system
    return amount.toFixed(2);
  }
};
// NEW FUNCTION: Create transaction when invoice is paid
const createTransactionForPaidInvoice = async (invoice, transactionNumber) => {
  try {
    console.log('🔄 Creating transaction for paid invoice:', invoice.invoiceNumber);
    
    // Prepare attachment data
    let attachment = null;
    if (invoice.paymentDetails?.proofFile) {
      const proofFile = invoice.paymentDetails.proofFile;

      console.log('📁 Payment proof file found:', {
        fileName: proofFile.fileName,
        filePath: proofFile.filePath,
        fileUrl: proofFile.fileUrl,
        size: proofFile.size
      });

      attachment = {
        filename: proofFile.fileName,
        originalName: proofFile.originalName,
        mimeType: proofFile.mimeType,
        size: proofFile.size,
        data: null,
        fileUrl: proofFile.fileUrl || null
      };

      if (proofFile.fileUrl) {
        console.log(`📎 Payment proof file attached: ${proofFile.originalName}`);
      }
    } else {
      console.log('❌ No payment proof file found in invoice');
    }

    const transactionData = {
      description: `${invoice.invoiceNumber}`,
      amount: invoice.totalAmount,
      type: 'Income',
      category: 'Project Revenue',
      remarks: `Transaction ID: ${transactionNumber}`,
      date: new Date(),
      createdBy: 'system'
    };

    // Only add attachment if it exists
    if (attachment) {
      transactionData.attachment = attachment;
    }

    const transaction = new Transaction(transactionData);
    await transaction.save();
    
    console.log(`✅ Transaction created successfully: ${transaction._id}`);
    console.log(`📊 Transaction details:`, {
      description: transaction.description,
      amount: transaction.amount,
      hasAttachment: !!transaction.attachment,
      attachmentSize: transaction.attachment?.data?.length || 0
    });
    
    return transaction;
  } catch (error) {
    console.error("❌ Error creating transaction for paid invoice:", error);
    throw error;
  }
};

// SIMPLIFIED FUNCTION: Auto-calculate due date based on customer payment terms
const calculateDueDate = (invoiceDate, paymentTerms) => {
  if (!paymentTerms || !invoiceDate) {
    console.log('❌ Missing payment terms or invoice date for due date calculation');
    return null;
  }
  
  try {
    const invoiceDateObj = new Date(invoiceDate);
    const dueDateObj = new Date(invoiceDateObj);
    dueDateObj.setDate(invoiceDateObj.getDate() + parseInt(paymentTerms));
    
    console.log(`📅 Due Date Calculation: ${invoiceDate} + ${paymentTerms} days = ${dueDateObj.toISOString().split('T')[0]}`);
    
    return dueDateObj;
  } catch (error) {
    console.error('❌ Error calculating due date:', error);
    return null;
  }
};

export const updateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
const {
  customerId,
  items,
  invoiceDate,
  dueDate,
  gstType,
  notes,
  currency,
  status
} = req.body;

    console.log('🔄 Updating invoice:', id);
    console.log('📦 Update data:', { status, customerId, items }); // Log the status

    // ✅ ENHANCED CHECK: FIND INVOICE WITH PAYMENT DETAILS
    const existingInvoice = await Invoice.findById(id).populate("customerId");
    if (!existingInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    console.log('📋 Existing invoice status:', {
      status: existingInvoice.status,
      paymentDetails: existingInvoice.paymentDetails,
      isPaid: existingInvoice.status === "paid"
    });

    // ✅ ONLY PREVENT EDITING FOR PAID INVOICES, NOT FOR STATUS CHANGES
    if (existingInvoice.status === "paid") {
      console.log('❌ Attempted to edit paid invoice:', existingInvoice.invoiceNumber);
      return res.status(400).json({ 
        message: "Cannot edit invoice that has been paid.",
        invoiceNumber: existingInvoice.invoiceNumber,
        status: existingInvoice.status
      });
    }

    // ✅ ADDITIONAL CHECK: If paymentDetails exist, consider it paid
    if (existingInvoice.paymentDetails && existingInvoice.paymentDetails.transactionNumber) {
      console.log('❌ Invoice has payment details, marking as non-editable');
      return res.status(400).json({ 
        message: "Cannot edit invoice that has payment verification. Edit functionality is disabled.",
        invoiceNumber: existingInvoice.invoiceNumber
      });
    }

    // Validate required fields
    if (!customerId || !items || items.length === 0) {
      return res.status(400).json({ message: "Customer ID and items are required" });
    }


    // Validate new fields
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.unitPrice === undefined || item.quantity === undefined) {
        return res.status(400).json({ 
          message: `Item ${i + 1}: unitPrice and quantity are required` 
        });
      }
    }

    // Fetch customer
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    //SIMPLIFIED AUTO-CALCULATION: Always calculate due date from payment terms
    let finalDueDate = null;
    if (customer.paymentTerms && invoiceDate) {
      finalDueDate = calculateDueDate(invoiceDate, customer.paymentTerms);
      console.log(`✅ Auto-calculated due date for update: ${finalDueDate?.toISOString().split('T')[0]} (${customer.paymentTerms} days from invoice date)`);
    }

    // If no due date could be calculated, use the existing due date
    if (!finalDueDate && existingInvoice.dueDate) {
      finalDueDate = existingInvoice.dueDate;
      console.log('ℹ️ Using existing due date from invoice');
    }

    // Calculate totals with new logic
      const subtotal = items.reduce(
        (sum, item) => {
          const unitPrice =
            Number(item.unitPrice) || 0;

          const quantity =
            Number(item.quantity) || 0;

          return sum + (unitPrice * quantity);
        },
        0
      );

      let totalGstAmount = 0;

      const calculatedItems = items.map(item => {

        const unitPrice =
          Number(item.unitPrice) || 0;

        const quantity =
          Number(item.quantity) || 0;

        const gstPercent =
          Number(item.gstPercent) || 0;

        const amount =
          unitPrice * quantity;

        const gstAmount =
          (amount * gstPercent) / 100;

        totalGstAmount += gstAmount;

        return {
          description: item.description,
          remarks: item.remarks || "",
          unitPrice,
          quantity,
          amount,
          gstPercent,
          gstAmount
        };
      });

      let cgstAmount = 0;
      let sgstAmount = 0;
      let igstAmount = 0;

      if (gstType === "INTRA_STATE") {

        cgstAmount = totalGstAmount / 2;
        sgstAmount = totalGstAmount / 2;

      } else if (gstType === "INTER_STATE") {

        igstAmount = totalGstAmount;
      }

      const grandTotal =
        subtotal + totalGstAmount;

    console.log('💰 Calculated totals:', { subtotal, totalGstAmount, grandTotal });

    // Update invoice in DB with new fields
     const updatedInvoice = await Invoice.findByIdAndUpdate(
      id,
      {
        customerId,
        items: calculatedItems,
        subtotal,
        gstType: gstType || "NONE",
        cgstAmount,
        sgstAmount,
        igstAmount,
        totalGstAmount,
        totalAmount: grandTotal,
        date: invoiceDate
          ? new Date(invoiceDate)
          : new Date(),

        dueDate: finalDueDate,
        notes: notes || '',
        currency: currency || "USD",
        status: status || existingInvoice.status // ✅ IMPORTANT: Include status update
      },
      { new: true, runValidators: true }
    ).populate("customerId");

    if (!updatedInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    console.log('✅ Invoice updated successfully:', updatedInvoice.invoiceNumber);

    res.json({
      message: "Invoice updated successfully",
      invoice: updatedInvoice
    });

  } catch (error) {
    console.error("❌ Error updating invoice:", error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Validation error',
        errors: Object.values(error.errors).map(e => e.message)
      });
    }
    res.status(500).json({ message: "Error updating invoice", error: error.message });
  }
};

// Serve payment proof files
export const getPaymentProof = async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      };

      const mimeType = mimeTypes[ext] || 'application/octet-stream';

      if (['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)) {
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      } else {
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }

      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      return;
    }

    const invoice = await Invoice.findOne({ 'paymentDetails.proofFile.fileName': filename }).lean();
    if (invoice?.paymentDetails?.proofFile?.fileUrl) {
      return res.redirect(invoice.paymentDetails.proofFile.fileUrl);
    }

    return res.status(404).json({ message: "File not found" });
  } catch (error) {
    console.error("Error serving payment proof:", error);
    res.status(500).json({ message: "Error serving file" });
  }
};
// Update invoice status in backend
// Update invoice status in backend
// const updateInvoiceEmailStatus = async (invoiceId, invoice) => {
//   try {
//     const updateData = {
//       status: 'sent', // ✅ THIS MUST BE 'sent' to change from draft to sent
//       emailSent: true,
//       emailSentAt: new Date(),
//       // Include all required fields to avoid validation errors
//       customerId: invoice.customerId._id,
//       items: invoice.items.map(item => ({
//         description: item.description,
//         remarks: item.remarks || "",
//         unitPrice: item.unitPrice,
//         quantity: item.quantity,
//         amount: item.amount
//       })),
//       totalAmount: invoice.totalAmount,
//       date: invoice.date,
//       dueDate: invoice.dueDate,
//       taxPercent: invoice.taxPercent || 0,
//       notes: invoice.notes || '',
//       currency: invoice.currency || 'USD'
//     };

//     console.log('🔄 Updating invoice status to "sent":', invoiceId);
//     console.log('📤 Update data:', updateData);

//     // Make sure this API call is working
//     const response = await billingService.updateInvoice(invoiceId, updateData);
//     console.log('✅ Invoice status updated to "sent" successfully');
    
//     return response;
//   } catch (error) {
//     console.error('❌ Error updating invoice status:', error);
//     console.error('❌ Error details:', error.response?.data);
//     throw error;
//   }
// };

// Get payment proof info for a specific invoice
export const getInvoicePaymentProof = async (req, res) => {
  try {
    const { id } = req.params;
   
    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    if (!invoice.paymentDetails?.proofFile) {
      return res.status(404).json({ message: "No payment proof found for this invoice" });
    }

    res.json({
      paymentProof: invoice.paymentDetails.proofFile
    });

  } catch (error) {
    console.error("Error fetching payment proof:", error);
    res.status(500).json({ message: "Error fetching payment proof", error: error.message });
  }
};

// Add this function to delete invoice
export const deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
   
    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    // ✅ CHECK IF INVOICE IS PAID - PREVENT DELETION
    if (invoice.status === "paid") {
      return res.status(400).json({ 
        message: "Cannot delete invoice that has been paid. Paid invoices cannot be deleted." 
      });
    }

    // Delete associated payment proof file if exists
    if (invoice.paymentDetails?.proofFile?.filePath) {
      try {
        if (fs.existsSync(invoice.paymentDetails.proofFile.filePath)) {
          fs.unlinkSync(invoice.paymentDetails.proofFile.filePath);
        }
      } catch (fileError) {
        console.error("Error deleting payment proof file:", fileError);
      }
    }

    const deletedInvoice = await Invoice.findByIdAndDelete(id);
   
    res.json({ message: "Invoice deleted successfully" });
   
  } catch (error) {
    console.error("Error deleting invoice:", error);
    res.status(500).json({ message: "Error deleting invoice", error: error.message });
  }
};

// Update the generateInvoice function with new fields
export const generateInvoice = async (req, res) => {
  try {
    const {
      customerId,
      items,
      invoiceDate,
      dueDate,
      gstType,
      notes,
      currency
    } = req.body;

    // =========================================================
    // VALIDATION
    // =========================================================

    if (!customerId || !items || items.length === 0) {
      return res.status(400).json({
        message: "Customer ID and items are required"
      });
    }

    // Validate item values
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (
        item.unitPrice === undefined ||
        item.quantity === undefined
      ) {
        return res.status(400).json({
          message: `Item ${i + 1}: unitPrice and quantity are required`
        });
      }
    }

    // =========================================================
    // FETCH CUSTOMER
    // =========================================================

    const customer = await Customer.findById(customerId);

    if (!customer) {
      return res.status(404).json({
        message: "Customer not found"
      });
    }

    // =========================================================
    // AUTO CALCULATE DUE DATE
    // =========================================================

    let finalDueDate = null;

    if (customer.paymentTerms && invoiceDate) {
      finalDueDate = calculateDueDate(
        invoiceDate,
        customer.paymentTerms
      );

      console.log(
        `✅ Auto-calculated due date: ${
          finalDueDate?.toISOString().split("T")[0]
        } (${customer.paymentTerms} days from invoice date)`
      );
    } else {
      console.log(
        "❌ Cannot calculate due date - missing payment terms or invoice date"
      );

      return res.status(400).json({
        message:
          "Cannot generate invoice: Customer payment terms or invoice date is missing"
      });
    }

    // =========================================================
    // FETCH COMPANY
    // =========================================================

    const company = await Company.findOne();

    if (!company) {
      return res.status(404).json({
        message:
          "Company information not found. Please set up company details first."
      });
    }

    if (!company.companyName || !company.address) {
      console.log("❌ Company information incomplete:", {
        hasCompanyName: !!company.companyName,
        hasAddress: !!company.address
      });

      return res.status(400).json({
        message:
          "Company information is incomplete. Please complete company details in Company Settings."
      });
    }

    // =========================================================
    // LOAD LOGO AND SIGNATURE
    // =========================================================

    let logoBuffer = null;
    let signatureBuffer = null;

    // Load company logo
    try {
      if (company.logo?.public_id) {
        const logoResponse = await axios({
          method: "GET",
          url: await getSignedUrlForKey(company.logo.public_id),
          responseType: "arraybuffer",
          timeout: 10000
        });

        logoBuffer = Buffer.from(logoResponse.data);

        console.log(
          "✅ Company logo loaded successfully"
        );
      }
    } catch (logoError) {
      console.error(
        "❌ Error loading logo:",
        logoError.message
      );
    }

    // Load company signature
    try {
      if (company.signature?.public_id) {
        const signatureResponse = await axios({
          method: "GET",
          url: await getSignedUrlForKey(company.signature.public_id),
          responseType: "arraybuffer",
          timeout: 10000
        });

        signatureBuffer = Buffer.from(
          signatureResponse.data
        );

        console.log(
          "✅ Company signature loaded successfully"
        );
      }
    } catch (signatureError) {
      console.error(
        "❌ Error loading signature:",
        signatureError.message
      );
    }

    // =========================================================
    // GST CALCULATION
    // =========================================================

    let subtotal = 0;
    let totalGstAmount = 0;

    const calculatedItems = items.map((item) => {
      const unitPrice =
        Number(item.unitPrice) || 0;

      const quantity =
        Number(item.quantity) || 0;

      const gstPercent =
        Number(item.gstPercent) || 0;

      // Taxable amount
      const amount =
        unitPrice * quantity;

      // GST amount for this line
      const gstAmount =
        (amount * gstPercent) / 100;

      subtotal += amount;
      totalGstAmount += gstAmount;

      return {
        description: item.description || "",
        remarks: item.remarks || "",

        unitPrice,
        quantity,

        amount,

        gstPercent,
        gstAmount
      };
    });

    // =========================================================
    // GST TYPE CALCULATION
    // =========================================================

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (gstType === "INTRA_STATE") {

      // Total GST is divided equally
      // between CGST and SGST

      cgstAmount =
        totalGstAmount / 2;

      sgstAmount =
        totalGstAmount / 2;

    } else if (gstType === "INTER_STATE") {

      // Entire GST becomes IGST

      igstAmount =
        totalGstAmount;
    }

    // Grand total
    const grandTotal =
      subtotal + totalGstAmount;

    // =========================================================
    // SAVE INVOICE
    // =========================================================

    const invoice = new Invoice({

      customerId,

      items: calculatedItems,

      subtotal,

      gstType:
        gstType || "NONE",

      cgstAmount,

      sgstAmount,

      igstAmount,

      totalGstAmount,

      totalAmount:
        grandTotal,

      date: invoiceDate
        ? new Date(invoiceDate)
        : new Date(),

      dueDate:
        finalDueDate,

      notes,

      currency:
        currency || "USD",

      status: "draft"
    });

    await invoice.save();

    // =========================================================
    // FETCH SAVED INVOICE
    // =========================================================

    const savedInvoice =
      await Invoice
        .findById(invoice._id)
        .populate("customerId");

    // =========================================================
    // PDF SETUP
    // =========================================================

    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      bufferPages: true
    });

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${savedInvoice.invoiceNumber}.pdf`
    );

    doc.pipe(res);

    // =========================================================
    // PDF POSITION VARIABLES
    // =========================================================

    let currentY = 30;

    const leftColumn = 50;

    const rightColumn = 350;

    const pageWidth = 550;

    // Currency
    const currencySymbol =
      getCurrencySymbol(currency);

    const amountWords =
      getAmountInWords(
        grandTotal,
        currency
      );

    // =========================================================
    // HEADER
    // =========================================================

    const addHeader = () => {

      const headerY = 30;

      // -------------------------------------------------------
      // LOGO
      // -------------------------------------------------------

      const logoWidth = 140;
      const logoHeight = 100;

      const logoX =
        pageWidth -
        logoWidth +
        15;

      if (logoBuffer) {

        try {

          doc.image(
            logoBuffer,
            logoX,
            20,
            {
              width: logoWidth,
              height: logoHeight
            }
          );

        } catch (logoError) {

          console.error(
            "❌ Error adding logo:",
            logoError.message
          );
        }
      }

      // -------------------------------------------------------
      // COMPANY NAME
      // -------------------------------------------------------

      doc
        .fontSize(20)
        .font("Helvetica-Bold")
        .fillColor("#000")
        .text(
          company.companyName,
          leftColumn,
          headerY
        );

      doc
        .fontSize(10)
        .font("Helvetica");

      const lineSpacing = 2;

      let headerCurrentY =
        headerY + 30;

      // -------------------------------------------------------
      // ADDRESS
      // -------------------------------------------------------

      const addressText =
        company.address ||
        "123 Main Street, City, ZIP";

      const addressWidth =
        pageWidth / 2;

      const addressHeight =
        doc.heightOfString(
          addressText,
          {
            width: addressWidth
          }
        );

      doc.text(
        addressText,
        leftColumn,
        headerCurrentY,
        {
          width: addressWidth
        }
      );

      headerCurrentY +=
        addressHeight +
        lineSpacing;

      // -------------------------------------------------------
      // PHONE
      // -------------------------------------------------------

      doc.text(
        `Phone: ${
          company.phone ||
          "000-000-0000"
        }`,
        leftColumn,
        headerCurrentY
      );

      headerCurrentY +=
        12 + lineSpacing;

      // -------------------------------------------------------
      // EMAIL
      // -------------------------------------------------------

      doc.text(
        `Email: ${
          company.email ||
          "contact@company.com"
        }`,
        leftColumn,
        headerCurrentY
      );

      headerCurrentY +=
        12 + lineSpacing;

      // -------------------------------------------------------
      // GST NUMBER
      // -------------------------------------------------------

      if (company.gstNumber) {

        doc
          .fontSize(10)
          .font("Helvetica")
          .text(
            `GST: ${company.gstNumber}`,
            leftColumn,
            headerCurrentY
          );

        headerCurrentY +=
          12 + lineSpacing;
      }

      // -------------------------------------------------------
      // HEADER LINE
      // -------------------------------------------------------

      const lineY =
        Math.max(
          headerY + logoHeight,
          headerCurrentY
        ) + 10;

      doc
        .moveTo(
          leftColumn,
          lineY
        )
        .lineTo(
          pageWidth,
          lineY
        )
        .stroke();

      return lineY + 20;
    };

    // =========================================================
    // FOOTER LINE
    // =========================================================

    const addFooterLine = () => {

      const footerY = 750;

      doc
        .moveTo(
          leftColumn,
          footerY
        )
        .lineTo(
          pageWidth,
          footerY
        )
        .stroke();
    };

    // =========================================================
    // FINAL FOOTER
    // =========================================================

    const addFinalFooter = () => {

      const footerY = 750;

      doc
        .moveTo(
          leftColumn,
          footerY
        )
        .lineTo(
          pageWidth,
          footerY
        )
        .stroke();

      doc
        .fontSize(14)
        .font("Helvetica")
        .text(
          "Thank You For Your Business!",
          (leftColumn + pageWidth) / 2,
          footerY + 15,
          {
            align: "right"
          }
        );
    };

    // =========================================================
    // GST TABLE
    // =========================================================

    const tableX =
      leftColumn;

    const tableWidth =
      pageWidth -
      leftColumn;

    /*
      Total width:

      105 Description
       75 Remarks
       70 Unit Price
       40 Quantity
       75 Amount
       50 GST %
       85 GST Amount
      --------------------------------
      500 total
    */

      const tableColumns = {

        description: {
          x: tableX,
          width: 105
        },

        remarks: {
          x: tableX + 105,
          width: 75
        },

        unitPrice: {
          x: tableX + 180,
          width: 70
        },

        quantity: {
          x: tableX + 250,
          width: 40
        },

        gstPercent: {
          x: tableX + 290,
          width: 50
        },

        gstAmount: {
          x: tableX + 340,
          width: 85
        },

        amount: {
          x: tableX + 425,
          width: 75
        }
      };

    // =========================================================
    // TABLE HEADER
    // =========================================================

    const addTableHeader = (
      yPosition
    ) => {

      // Header background

      doc
        .rect(
          tableX,
          yPosition,
          tableWidth+5,
          24
        )
        .fill("#f0f0f0");

      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#000");

      // Description

      doc.text(
        "DESCRIPTION",
        tableColumns.description.x + 5,
        yPosition + 8,
        {
          width:
            tableColumns.description.width -
            10,
          align: "left"
        }
      );

      // Remarks

      doc.text(
        "REMARKS",
        tableColumns.remarks.x + 5,
        yPosition + 8,
        {
          width:
            tableColumns.remarks.width -
            10,
          align: "left"
        }
      );

      // Unit price

      doc.text(
        "UNIT PRICE",
        tableColumns.unitPrice.x,
        yPosition + 8,
        {
          width:
            tableColumns.unitPrice.width,
          align: "right"
        }
      );

      // Quantity

      doc.text(
        "QTY",
        tableColumns.quantity.x,
        yPosition + 8,
        {
          width:
            tableColumns.quantity.width,
          align: "center"
        }
      );

      // GST %

      doc.text(
        "GST %",
        tableColumns.gstPercent.x,
        yPosition + 8,
        {
          width:
            tableColumns.gstPercent.width,
          align: "right"
        }
      );

      doc.text(
        "GST AMOUNT",
        tableColumns.gstAmount.x,
        yPosition + 8,
        {
          width:
            tableColumns.gstAmount.width,
          align: "right"
        }
      );

      doc.text(
        "AMOUNT",
        tableColumns.amount.x,
        yPosition + 8,
        {
          width:
            tableColumns.amount.width,
          align: "right"
        }
      );

      doc.fillColor("#000");
    };

    // =========================================================
    // PAGE TRACKING
    // =========================================================

    let pageNumber = 1;

    currentY =
      addHeader(pageNumber);

    doc.on(
      "pageAdded",
      () => {

        pageNumber++;

        currentY =
          addHeader(pageNumber);

        addFooterLine();
      }
    );

    // Footer for first page
    addFooterLine();

    // =========================================================
    // BILL TO
    // =========================================================

    const billToStartY =
      currentY;

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(
        "BILL TO",
        leftColumn,
        currentY
      );

    currentY += 25;

    const customerCompany =
      customer.company;

    const addressLines = [];

    // Customer company

    if (customerCompany) {

      addressLines.push(
        customerCompany
      );
    }

    // Address line 1

    if (
      customer.address?.addressLine1
    ) {

      let line =
        customer.address.addressLine1;

      if (!line.endsWith(",")) {
        line += ",";
      }

      addressLines.push(line);
    }

    // Address line 2

    if (
      customer.address?.addressLine2
    ) {

      let line =
        customer.address.addressLine2;

      if (!line.endsWith(",")) {
        line += ",";
      }

      addressLines.push(line);
    }

    // City / State / Pincode

    const cityStatePin = [];

    if (customer.address?.city) {

      cityStatePin.push(
        customer.address.city
      );
    }

    if (
      customer.address?.state?.name
    ) {

      cityStatePin.push(
        customer.address.state.name
      );
    }

    if (
      customer.address?.pinCode
    ) {

      cityStatePin.push(
        customer.address.pinCode
      );
    }

    if (
      cityStatePin.length > 0
    ) {

      addressLines.push(
        cityStatePin.join(", ") + ","
      );
    }

    // Country

    if (
      customer.address?.country?.name
    ) {

      addressLines.push(
        customer.address.country.name
      );
    }

    // Render address

    addressLines.forEach(
      (line, index) => {

        if (
          line &&
          line.trim() !== ""
        ) {

          if (
            index === 0 &&
            customerCompany
          ) {

            doc
              .fontSize(10)
              .font("Helvetica-Bold")
              .text(
                line,
                leftColumn,
                currentY
              );

          } else {

            doc
              .fontSize(10)
              .font("Helvetica")
              .text(
                line,
                leftColumn,
                currentY
              );
          }

          currentY += 15;
        }
      }
    );

    // Phone

    if (customer.phone) {

      doc.text(
        `Phone: ${customer.phone}`,
        leftColumn,
        currentY
      );

      currentY += 15;
    }

    // Email

    if (customer.email) {

      doc.text(
        `Email: ${customer.email}`,
        leftColumn,
        currentY
      );

      currentY += 15;
    }

    // =========================================================
    // INVOICE DETAILS
    // =========================================================

    currentY =
      billToStartY;

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(
        "INVOICE",
        rightColumn,
        currentY
      );

    currentY += 25;

    const detailLabels = [
      "DATE                 :",
      "INVOICE NO     :",
      "CUSTOMER ID :",
      "DUE DATE        :"
    ];

    const invDate =
      new Date(
        savedInvoice.date
      )
        .toISOString()
        .split("T")[0];

    const due =
      savedInvoice.dueDate
        ? new Date(
            savedInvoice.dueDate
          )
            .toISOString()
            .split("T")[0]
        : "N/A";

    const detailValues = [

      invDate,

      savedInvoice.invoiceNumber,

      savedInvoice.customerId
        ?.customerId || "",

      due
    ];

    detailLabels.forEach(
      (label, index) => {

        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text(
            label,
            rightColumn,
            currentY
          );

        doc
          .font("Helvetica")
          .text(
            detailValues[index],
            rightColumn + 80,
            currentY
          );

        currentY += 15;
      }
    );

    // =========================================================
    // ITEMS TABLE
    // =========================================================

    currentY =
      Math.max(
        currentY,
        billToStartY + 120
      ) + 10;

    addTableHeader(
      currentY
    );

    currentY += 30;

    // =========================================================
    // ITEMS
    // =========================================================

    calculatedItems.forEach(
      (item, index) => {

        const remarks =
          item.remarks || "";

        const unitPrice =
          Number(item.unitPrice) || 0;

        const quantity =
          Number(item.quantity) || 0;

        const amount =
          unitPrice * quantity;

        const gstPercent =
          Number(item.gstPercent) || 0;

        const gstAmount =
          (amount * gstPercent) / 100;

        // -----------------------------------------------------
        // FORMAT AMOUNTS
        // -----------------------------------------------------

        const formattedUnitPrice =
          formatCurrencyAmount(
            unitPrice,
            currency
          );

        const formattedAmount =
          formatCurrencyAmount(
            amount,
            currency
          );

        const formattedGstAmount =
          formatCurrencyAmount(
            gstAmount,
            currency
          );

        // -----------------------------------------------------
        // ROW HEIGHT
        // -----------------------------------------------------

        const descriptionHeight =
          doc.heightOfString(
            item.description || "",
            {
              width:
                tableColumns.description.width -
                10
            }
          );

        const remarksHeight =
          doc.heightOfString(
            remarks,
            {
              width:
                tableColumns.remarks.width -
                10
            }
          );

        const rowHeight =
          Math.max(
            descriptionHeight,
            remarksHeight,
            18
          );

        // -----------------------------------------------------
        // PAGE BREAK
        // -----------------------------------------------------

        if (
          currentY +
            rowHeight +
            10 >
          650
        ) {

          doc.addPage();

          // pageAdded event
          // already updates currentY

          currentY += 10;

          addTableHeader(
            currentY
          );

          currentY += 30;
        }

        // -----------------------------------------------------
        // ALTERNATE ROW BACKGROUND
        // -----------------------------------------------------

        if (index % 2 === 0) {

          doc
            .rect(
              tableX,
              currentY - 5,
              tableWidth,
              rowHeight + 10
            )
            .fillOpacity(0.08)
            .fill("#eeeeee")
            .fillOpacity(1)
            .fillColor("#000");
        }

        doc
          .fontSize(8)
          .font("Helvetica")
          .fillColor("#000");

        // -----------------------------------------------------
        // DESCRIPTION
        // -----------------------------------------------------

        doc.text(
          item.description || "",
          tableColumns.description.x + 5,
          currentY,
          {
            width:
              tableColumns.description.width -
              10,
            align: "left"
          }
        );

        // -----------------------------------------------------
        // REMARKS
        // -----------------------------------------------------

        doc.text(
          remarks,
          tableColumns.remarks.x + 5,
          currentY,
          {
            width:
              tableColumns.remarks.width -
              10,
            align: "left"
          }
        );

        // -----------------------------------------------------
        // UNIT PRICE
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedUnitPrice}`,
          tableColumns.unitPrice.x,
          currentY,
          {
            width:
              tableColumns.unitPrice.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // QUANTITY
        // -----------------------------------------------------

        doc.text(
          quantity.toString(),
          tableColumns.quantity.x,
          currentY,
          {
            width:
              tableColumns.quantity.width,
            align: "center"
          }
        );

        // -----------------------------------------------------
        // AMOUNT WITHOUT GST
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedAmount}`,
          tableColumns.amount.x,
          currentY,
          {
            width:
              tableColumns.amount.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // GST %
        // -----------------------------------------------------

        doc.text(
          `${gstPercent}%`,
          tableColumns.gstPercent.x,
          currentY,
          {
            width:
              tableColumns.gstPercent.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // GST AMOUNT
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedGstAmount}`,
          tableColumns.gstAmount.x,
          currentY,
          {
            width:
              tableColumns.gstAmount.width,
            align: "right"
          }
        );

        currentY +=
          rowHeight + 10;
      }
    );

    // =========================================================
    // GST TOTALS
    // =========================================================

    currentY += 10;

    const totalsHeight =
      gstType === "INTRA_STATE"
        ? 125
        : gstType === "INTER_STATE"
          ? 105
          : 85;

    if (
      currentY +
        totalsHeight >
      720
    ) {

      doc.addPage();

      currentY += 10;
    }

    // =========================================================
    // FORMAT TOTALS
    // =========================================================

    const formattedSubtotal =
      formatCurrencyAmount(
        subtotal,
        currency
      );

    const formattedCgst =
      formatCurrencyAmount(
        cgstAmount,
        currency
      );

    const formattedSgst =
      formatCurrencyAmount(
        sgstAmount,
        currency
      );

    const formattedIgst =
      formatCurrencyAmount(
        igstAmount,
        currency
      );

    const formattedTotalGst =
      formatCurrencyAmount(
        totalGstAmount,
        currency
      );

    const formattedGrandTotal =
      formatCurrencyAmount(
        grandTotal,
        currency
      );

    // =========================================================
    // TOTALS POSITION
    // =========================================================

    const totalsX =
      pageWidth - 220;

    const totalsValueX =
      pageWidth - 105;

    const totalsValueWidth =
      105;

    // =========================================================
    // TOTAL WITHOUT GST
    // =========================================================

    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#000")
      .text(
        "Total Without GST:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedSubtotal}`,
        totalsValueX,
        currentY,
        {
          width: totalsValueWidth,
          align: "right"
        }
      );

    currentY += 18;

    // =========================================================
    // CGST + SGST
    // =========================================================

    if (
      gstType === "INTRA_STATE"
    ) {

      // CGST

      doc
        .text(
          "CGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedCgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;

      // SGST

      doc
        .text(
          "SGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedSgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;
    }

    // =========================================================
    // IGST
    // =========================================================

    if (
      gstType === "INTER_STATE"
    ) {

      doc
        .text(
          "IGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedIgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;
    }

    // =========================================================
    // TOTAL GST
    // =========================================================

    doc
      .font("Helvetica-Bold")
      .text(
        "Total GST:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedTotalGst}`,
        totalsValueX,
        currentY,
        {
          width:
            totalsValueWidth,
          align: "right"
        }
      );

    currentY += 12;

    // =========================================================
    // GRAND TOTAL TOP LINE
    // =========================================================

    doc
      .moveTo(
        totalsX,
        currentY
      )
      .lineTo(
        pageWidth,
        currentY
      )
      .stroke();

    currentY += 12;

    // =========================================================
    // GRAND TOTAL
    // =========================================================

    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(
        "GRAND TOTAL:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedGrandTotal}`,
        totalsValueX,
        currentY,
        {
          width:
            totalsValueWidth,
          align: "right"
        }
      );

    currentY += 20;

    // Bottom line

    doc
      .moveTo(
        totalsX,
        currentY
      )
      .lineTo(
        pageWidth,
        currentY
      )
      .stroke();

    currentY += 20;

    // =========================================================
    // AMOUNT IN WORDS
    // =========================================================

    const wordsHeight =
      doc.heightOfString(
        amountWords + "/- .",
        {
          width:
            pageWidth - leftColumn
        }
      );

    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(
        `Amount in Words: ${amountWords}`,
        leftColumn,
        currentY,
        {
          width:
            pageWidth - leftColumn
        }
      );

    currentY +=
      wordsHeight + 20;

    // =========================================================
    // BANK ACCOUNT DETAILS
    // =========================================================

    if (
      company.accountNo ||
      company.bank ||
      company.ifsc
    ) {

      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(
          "Account Details",
          leftColumn,
          currentY
        );

      currentY += 15;

      let accountY =
        currentY;

      const colonX =
        leftColumn + 80;

      const valueX =
        colonX + 10;

      const lineHeight = 12;

      // Bank

      if (company.bank) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Bank",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.bank,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Name

      if (company.accountName) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account Name",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountName,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Number

      if (company.accountNo) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account No",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountNo.toString(),
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // IFSC

      if (company.ifsc) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "IFSC Code",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.ifsc,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Type

      if (company.accountType) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account Type",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountType,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Branch

      if (company.branch) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Branch",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.branch,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      currentY =
        accountY + 10;
    }

    // =========================================================
    // OTHER COMMENTS
    // =========================================================

    if (
      notes &&
      notes.trim() !== ""
    ) {

      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(
          "OTHER COMMENTS",
          leftColumn,
          currentY
        );

      currentY += 15;

      const sentences =
        notes
          .split(".")
          .map(
            (s) => s.trim()
          )
          .filter(
            (s) => s.length > 0
          );

      doc
        .fontSize(10)
        .font("Helvetica");

      sentences.forEach(
        (sentence) => {

          const bulletText =
            `• ${sentence}.`;

          const textHeight =
            doc.heightOfString(
              bulletText,
              {
                width: 500
              }
            );

          doc.text(
            bulletText,
            leftColumn + 10,
            currentY,
            {
              width: 500
            }
          );

          currentY +=
            textHeight + 5;
        }
      );
    }

    // =========================================================
    // TERMS AND CONDITIONS
    // =========================================================

    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(
        "Terms & Conditions",
        leftColumn,
        currentY
      );

    currentY += 15;

    const defaultComments = [
      "Please include the invoice number on your check."
    ];

    // Payment due

    const paymentDueText =
      `• Total payment due in ${customer.paymentTerms} days.`;

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        paymentDueText,
        leftColumn + 10,
        currentY
      );

    currentY += 15;

    // Default comments

    defaultComments.forEach(
      (comment) => {

        doc
          .fontSize(10)
          .font("Helvetica")
          .text(
            `• ${comment}`,
            leftColumn + 10,
            currentY
          );

        currentY += 15;
      }
    );

    // =========================================================
    // SIGNATURE
    // =========================================================

    const signatureY = 680;

    const signatureX =
      pageWidth - 125;

    const signatureWidth = 100;

    const signatureHeight = 50;

    if (signatureBuffer) {

      try {

        doc.image(
          signatureBuffer,
          signatureX - 20,
          signatureY - 55,
          {
            width:
              signatureWidth,

            height:
              signatureHeight
          }
        );

        console.log(
          "✅ Signature added to PDF"
        );

      } catch (signatureError) {

        console.error(
          "❌ Error adding signature:",
          signatureError.message
        );
      }
    }

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        "For Zynith IT Solutions",
        signatureX - 40,
        signatureY + 5,
        {
          width: 150,
          align: "center"
        }
      );

    // =========================================================
    // FINAL FOOTER
    // =========================================================

    addFinalFooter();

    // =========================================================
    // END PDF
    // =========================================================

    doc.end();

  } catch (error) {

    console.error(
      "Error generating invoice:",
      error
    );

    // Only send JSON if the PDF response
    // hasn't already started

    if (!res.headersSent) {
      return res.status(500).json({
        message:
          "Error generating invoice",
        error:
          error.message
      });
    }
  }
};

// Update the downloadInvoice function with new fields
export const downloadInvoice = async (req, res) => {
  try {
    console.log(
      "📥 Download invoice request received for ID:",
      req.params.id
    );

    const { id } = req.params;

    // =========================================================
    // VALIDATION
    // =========================================================

    if (!id) {
      return res.status(400).json({
        message: "Invoice ID is required"
      });
    }

    // =========================================================
    // FETCH INVOICE + CUSTOMER
    // =========================================================

    const invoice = await Invoice.findById(id)
      .populate("customerId");

    if (!invoice) {
      return res.status(404).json({
        message: "Invoice not found"
      });
    }

    const customer = invoice.customerId;

    if (!customer) {
      return res.status(404).json({
        message: "Customer information not found"
      });
    }

    // =========================================================
    // FETCH COMPANY
    // =========================================================

    const company = await Company.findOne();

    if (!company) {
      console.log(
        "❌ Company information not found for download"
      );

      return res.status(404).json({
        message:
          "Company information not found. Please set up company details first in Company Settings."
      });
    }

    if (
      !company.companyName ||
      !company.address
    ) {
      console.log(
        "❌ Company information incomplete for download"
      );

      return res.status(400).json({
        message:
          "Company information is incomplete. Please complete company details in Company Settings."
      });
    }

    // =========================================================
    // LOAD LOGO + SIGNATURE
    // =========================================================

    let logoBuffer = null;
    let signatureBuffer = null;

    // ---------------------------------------------------------
    // COMPANY LOGO
    // ---------------------------------------------------------

    try {
      if (company.logo?.public_id) {
        const logoResponse = await axios({
          method: "GET",
          url: await getSignedUrlForKey(company.logo.public_id),
          responseType: "arraybuffer",
          timeout: 10000
        });

        logoBuffer = Buffer.from(
          logoResponse.data
        );

        console.log(
          "✅ Logo loaded from Cloudinary for download"
        );
      }
    } catch (logoError) {
      console.error(
        "❌ Error loading logo from Cloudinary:",
        logoError.message
      );
    }

    // ---------------------------------------------------------
    // COMPANY SIGNATURE
    // ---------------------------------------------------------

    try {
      if (company.signature?.public_id) {
        const signatureResponse = await axios({
          method: "GET",
          url: await getSignedUrlForKey(company.signature.public_id),
          responseType: "arraybuffer",
          timeout: 10000
        });

        signatureBuffer = Buffer.from(
          signatureResponse.data
        );

        console.log(
          "✅ Signature loaded from Cloudinary for download"
        );
      }
    } catch (signatureError) {
      console.error(
        "❌ Error loading signature from Cloudinary:",
        signatureError.message
      );
    }

    // =========================================================
    // GST / ITEM CALCULATION
    // =========================================================

    const invoiceItems =
      Array.isArray(invoice.items)
        ? invoice.items
        : [];

    let subtotal = 0;
    let totalGstAmount = 0;

    const calculatedItems =
      invoiceItems.map((item) => {

        const unitPrice =
          Number(item.unitPrice) || 0;

        const quantity =
          Number(item.quantity) || 0;

        const amount =
          item.amount !== undefined &&
          item.amount !== null
            ? Number(item.amount) || 0
            : unitPrice * quantity;

        const gstPercent =
          Number(item.gstPercent) || 0;

        const gstAmount =
          item.gstAmount !== undefined &&
          item.gstAmount !== null
            ? Number(item.gstAmount) || 0
            : (amount * gstPercent) / 100;

        subtotal += amount;

        totalGstAmount += gstAmount;

        return {
          description:
            item.description || "",

          remarks:
            item.remarks || "",

          unitPrice,

          quantity,

          amount,

          gstPercent,

          gstAmount
        };
      });

    // =========================================================
    // GST TYPE
    // =========================================================

    const gstType =
      invoice.gstType || "NONE";

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    // ---------------------------------------------------------
    // INTRA STATE
    // ---------------------------------------------------------

    if (gstType === "INTRA_STATE") {

      cgstAmount =
        invoice.cgstAmount !== undefined &&
        invoice.cgstAmount !== null
          ? Number(invoice.cgstAmount)
          : totalGstAmount / 2;

      sgstAmount =
        invoice.sgstAmount !== undefined &&
        invoice.sgstAmount !== null
          ? Number(invoice.sgstAmount)
          : totalGstAmount / 2;
    }

    // ---------------------------------------------------------
    // INTER STATE
    // ---------------------------------------------------------

    if (gstType === "INTER_STATE") {

      igstAmount =
        invoice.igstAmount !== undefined &&
        invoice.igstAmount !== null
          ? Number(invoice.igstAmount)
          : totalGstAmount;
    }

    // =========================================================
    // GRAND TOTAL
    // =========================================================

    const grandTotal =
      invoice.totalAmount !== undefined &&
      invoice.totalAmount !== null
        ? Number(invoice.totalAmount)
        : subtotal + totalGstAmount;

    // =========================================================
    // PDF SETUP
    // =========================================================

    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      bufferPages: true
    });

    // =========================================================
    // RESPONSE HEADERS
    // =========================================================

    res.setHeader(
      "Content-Type",
      "application/pdf"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${invoice.invoiceNumber}.pdf`
    );

    res.setHeader(
      "X-Invoice-Number",
      invoice.invoiceNumber
    );

    doc.pipe(res);

    // =========================================================
    // PDF POSITIONING
    // =========================================================

    let currentY = 30;

    const leftColumn = 50;

    const rightColumn = 350;

    const pageWidth = 550;

    const currency =
      invoice.currency || "INR";

    const currencySymbol =
      getCurrencySymbol(currency);

    const amountWords =
      getAmountInWords(
        grandTotal,
        currency
      );

    // =========================================================
    // HEADER
    // =========================================================

    const addHeader = () => {

      const headerY = 30;

      // -------------------------------------------------------
      // LOGO
      // -------------------------------------------------------

      const logoWidth = 140;

      const logoHeight = 100;

      const logoX =
        pageWidth -
        logoWidth +
        15;

      if (logoBuffer) {
        try {

          doc.image(
            logoBuffer,
            logoX,
            20,
            {
              width: logoWidth,
              height: logoHeight
            }
          );

        } catch (logoError) {

          console.error(
            "❌ Error adding logo:",
            logoError.message
          );
        }
      }

      // -------------------------------------------------------
      // COMPANY NAME
      // -------------------------------------------------------

      doc
        .fontSize(20)
        .font("Helvetica-Bold")
        .fillColor("#000")
        .text(
          company.companyName,
          leftColumn,
          headerY
        );

      // -------------------------------------------------------
      // COMPANY DETAILS
      // -------------------------------------------------------

      doc
        .fontSize(10)
        .font("Helvetica");

      const lineSpacing = 2;

      let headerCurrentY =
        headerY + 30;

      const addressText =
        company.address ||
        "123 Main Street, City, ZIP";

      const addressWidth =
        pageWidth / 2;

      const addressHeight =
        doc.heightOfString(
          addressText,
          {
            width: addressWidth
          }
        );

      doc.text(
        addressText,
        leftColumn,
        headerCurrentY,
        {
          width: addressWidth
        }
      );

      headerCurrentY +=
        addressHeight +
        lineSpacing;

      // Phone

      doc.text(
        `Phone: ${
          company.phone ||
          "000-000-0000"
        }`,
        leftColumn,
        headerCurrentY
      );

      headerCurrentY +=
        12 + lineSpacing;

      // Email

      doc.text(
        `Email: ${
          company.email ||
          "contact@company.com"
        }`,
        leftColumn,
        headerCurrentY
      );

      headerCurrentY +=
        12 + lineSpacing;

      // GST

      if (company.gstNumber) {

        doc.text(
          `GST: ${company.gstNumber}`,
          leftColumn,
          headerCurrentY
        );

        headerCurrentY +=
          12 + lineSpacing;
      }

      // -------------------------------------------------------
      // HEADER LINE
      // -------------------------------------------------------

      const lineY =
        Math.max(
          headerY + logoHeight,
          headerCurrentY
        ) + 10;

      doc
        .moveTo(
          leftColumn,
          lineY
        )
        .lineTo(
          pageWidth,
          lineY
        )
        .stroke();

      return lineY + 20;
    };

    // =========================================================
    // FOOTER LINE
    // =========================================================

    const addFooterLine = () => {

      const footerY = 750;

      doc
        .moveTo(
          leftColumn,
          footerY
        )
        .lineTo(
          pageWidth,
          footerY
        )
        .stroke();
    };

    // =========================================================
    // FINAL FOOTER
    // =========================================================

    const addFinalFooter = () => {

      const footerY = 750;

      doc
        .moveTo(
          leftColumn,
          footerY
        )
        .lineTo(
          pageWidth,
          footerY
        )
        .stroke();

      doc
        .fontSize(14)
        .font("Helvetica")
        .text(
          "Thank You For Your Business!",
          (leftColumn + pageWidth) / 2,
          footerY + 15,
          {
            align: "right"
          }
        );
    };

    // =========================================================
    // TABLE COLUMNS
    // =========================================================

    /*
      ORDER:

      DESCRIPTION
      REMARKS
      UNIT PRICE
      QUANTITY
      GST %
      GST AMOUNT
      AMOUNT
    */

    const tableX =
      leftColumn;

    const tableWidth =
      pageWidth - leftColumn;

    const tableColumns = {

      description: {
        x: tableX,
        width: 105
      },

      remarks: {
        x: tableX + 105,
        width: 75
      },

      unitPrice: {
        x: tableX + 180,
        width: 70
      },

      quantity: {
        x: tableX + 250,
        width: 40
      },

      gstPercent: {
        x: tableX + 290,
        width: 50
      },

      gstAmount: {
        x: tableX + 340,
        width: 85
      },

      amount: {
        x: tableX + 425,
        width: 75
      }
    };

    // =========================================================
    // TABLE HEADER
    // =========================================================

    const addTableHeader = (
      yPosition
    ) => {

      // Header background

      doc
        .rect(
          tableX,
          yPosition,
          tableWidth+5,
          24
        )
        .fill("#f0f0f0");

      doc
        .fontSize(7)
        .font("Helvetica-Bold")
        .fillColor("#000");

      // Description

      doc.text(
        "DESCRIPTION",
        tableColumns.description.x + 5,
        yPosition + 8,
        {
          width:
            tableColumns.description.width -
            10,
          align: "left"
        }
      );

      // Remarks

      doc.text(
        "REMARKS",
        tableColumns.remarks.x + 5,
        yPosition + 8,
        {
          width:
            tableColumns.remarks.width -
            10,
          align: "left"
        }
      );

      // Unit Price

      doc.text(
        "UNIT PRICE",
        tableColumns.unitPrice.x,
        yPosition + 8,
        {
          width:
            tableColumns.unitPrice.width,
          align: "right"
        }
      );

      // Quantity

      doc.text(
        "QTY",
        tableColumns.quantity.x,
        yPosition + 8,
        {
          width:
            tableColumns.quantity.width,
          align: "center"
        }
      );

      // GST %

      doc.text(
        "GST %",
        tableColumns.gstPercent.x,
        yPosition + 8,
        {
          width:
            tableColumns.gstPercent.width,
          align: "right"
        }
      );

      // GST Amount

      doc.text(
        "GST AMOUNT",
        tableColumns.gstAmount.x,
        yPosition + 8,
        {
          width:
            tableColumns.gstAmount.width,
          align: "right"
        }
      );

      // Amount

      doc.text(
        "AMOUNT",
        tableColumns.amount.x,
        yPosition + 8,
        {
          width:
            tableColumns.amount.width,
          align: "right"
        }
      );

      doc.fillColor("#000");
    };

    // =========================================================
    // PAGE TRACKING
    // =========================================================

    let pageNumber = 1;

    currentY =
      addHeader(pageNumber);

    doc.on(
      "pageAdded",
      () => {

        pageNumber++;

        currentY =
          addHeader(pageNumber);

        addFooterLine();
      }
    );

    // First page footer

    addFooterLine();

    // =========================================================
    // BILL TO
    // =========================================================

    const billToStartY =
      currentY;

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(
        "BILL TO",
        leftColumn,
        currentY
      );

    currentY += 25;

    const customerCompany =
      customer.company;

    const addressLines = [];

    // Customer company

    if (customerCompany) {
      addressLines.push(
        customerCompany
      );
    }

    // Address Line 1

    if (
      customer.address?.addressLine1
    ) {

      let line =
        customer.address.addressLine1;

      if (!line.endsWith(",")) {
        line += ",";
      }

      addressLines.push(line);
    }

    // Address Line 2

    if (
      customer.address?.addressLine2
    ) {

      let line =
        customer.address.addressLine2;

      if (!line.endsWith(",")) {
        line += ",";
      }

      addressLines.push(line);
    }

    // City / State / Pincode

    const cityStatePin = [];

    if (customer.address?.city) {

      cityStatePin.push(
        customer.address.city
      );
    }

    if (
      customer.address?.state?.name
    ) {

      cityStatePin.push(
        customer.address.state.name
      );
    }

    if (
      customer.address?.pinCode
    ) {

      cityStatePin.push(
        customer.address.pinCode
      );
    }

    if (
      cityStatePin.length > 0
    ) {

      addressLines.push(
        cityStatePin.join(", ") + ","
      );
    }

    // Country

    if (
      customer.address?.country?.name
    ) {

      addressLines.push(
        customer.address.country.name
      );
    }

    // Render address

    addressLines.forEach(
      (line, index) => {

        if (
          line &&
          line.trim() !== ""
        ) {

          if (
            index === 0 &&
            customerCompany
          ) {

            doc
              .fontSize(10)
              .font("Helvetica-Bold")
              .text(
                line,
                leftColumn,
                currentY
              );

          } else {

            doc
              .fontSize(10)
              .font("Helvetica")
              .text(
                line,
                leftColumn,
                currentY
              );
          }

          currentY += 15;
        }
      }
    );

    // Phone

    if (customer.phone) {

      doc.text(
        `Phone: ${customer.phone}`,
        leftColumn,
        currentY
      );

      currentY += 15;
    }

    // Email

    if (customer.email) {

      doc.text(
        `Email: ${customer.email}`,
        leftColumn,
        currentY
      );

      currentY += 15;
    }

    // =========================================================
    // INVOICE DETAILS
    // =========================================================

    currentY =
      billToStartY;

    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(
        "INVOICE",
        rightColumn,
        currentY
      );

    currentY += 25;

    const invDate =
      invoice.date
        ? new Date(invoice.date)
            .toISOString()
            .split("T")[0]
        : "N/A";

    const due =
      invoice.dueDate
        ? new Date(invoice.dueDate)
            .toISOString()
            .split("T")[0]
        : "N/A";

    const detailLabels = [
      "DATE                 :",
      "INVOICE NO     :",
      "CUSTOMER ID :",
      "DUE DATE        :"
    ];

    const detailValues = [
      invDate,
      invoice.invoiceNumber,
      customer.customerId || "",
      due
    ];

    detailLabels.forEach(
      (label, index) => {

        doc
          .fontSize(10)
          .font("Helvetica-Bold")
          .text(
            label,
            rightColumn,
            currentY
          );

        doc
          .font("Helvetica")
          .text(
            detailValues[index],
            rightColumn + 80,
            currentY
          );

        currentY += 15;
      }
    );

    // =========================================================
    // ITEMS TABLE POSITION
    // =========================================================

    const leftColumnBottom =
      billToStartY + 120;

    currentY =
      Math.max(
        currentY,
        leftColumnBottom
      ) + 10;

    addTableHeader(
      currentY
    );

    currentY += 30;

    // =========================================================
    // ITEMS
    // =========================================================

    calculatedItems.forEach(
      (item, index) => {

        // -----------------------------------------------------
        // CALCULATIONS
        // -----------------------------------------------------

        const remarks =
          item.remarks || "";

        const unitPrice =
          Number(item.unitPrice) || 0;

        const quantity =
          Number(item.quantity) || 0;

        const amount =
          Number(item.amount) || 0;

        const gstPercent =
          Number(item.gstPercent) || 0;

        const gstAmount =
          Number(item.gstAmount) || 0;

        // -----------------------------------------------------
        // FORMAT AMOUNTS
        // -----------------------------------------------------

        const formattedUnitPrice =
          formatCurrencyAmount(
            unitPrice,
            currency
          );

        const formattedGstAmount =
          formatCurrencyAmount(
            gstAmount,
            currency
          );

        const formattedAmount =
          formatCurrencyAmount(
            amount,
            currency
          );

        // -----------------------------------------------------
        // ROW HEIGHT
        // -----------------------------------------------------

        const descriptionHeight =
          doc.heightOfString(
            item.description || "",
            {
              width:
                tableColumns.description.width -
                10
            }
          );

        const remarksHeight =
          doc.heightOfString(
            remarks,
            {
              width:
                tableColumns.remarks.width -
                10
            }
          );

        const rowHeight =
          Math.max(
            descriptionHeight,
            remarksHeight,
            18
          );

        // -----------------------------------------------------
        // PAGE BREAK
        // -----------------------------------------------------

        if (
          currentY +
            rowHeight +
            10 >
          650
        ) {

          doc.addPage();

          currentY += 10;

          addTableHeader(
            currentY
          );

          currentY += 30;
        }

        // -----------------------------------------------------
        // ALTERNATE ROW
        // -----------------------------------------------------

        if (index % 2 === 0) {

          doc
            .rect(
              tableX,
              currentY - 5,
              tableWidth,
              rowHeight + 10
            )
            .fillOpacity(0.08)
            .fill("#eeeeee")
            .fillOpacity(1)
            .fillColor("#000");
        }

        doc
          .fontSize(8)
          .font("Helvetica")
          .fillColor("#000");

        // -----------------------------------------------------
        // DESCRIPTION
        // -----------------------------------------------------

        doc.text(
          item.description || "",
          tableColumns.description.x + 5,
          currentY,
          {
            width:
              tableColumns.description.width -
              10,
            align: "left"
          }
        );

        // -----------------------------------------------------
        // REMARKS
        // -----------------------------------------------------

        doc.text(
          remarks,
          tableColumns.remarks.x + 5,
          currentY,
          {
            width:
              tableColumns.remarks.width -
              10,
            align: "left"
          }
        );

        // -----------------------------------------------------
        // UNIT PRICE
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedUnitPrice}`,
          tableColumns.unitPrice.x,
          currentY,
          {
            width:
              tableColumns.unitPrice.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // QUANTITY
        // -----------------------------------------------------

        doc.text(
          quantity.toString(),
          tableColumns.quantity.x,
          currentY,
          {
            width:
              tableColumns.quantity.width,
            align: "center"
          }
        );

        // -----------------------------------------------------
        // GST %
        // -----------------------------------------------------

        doc.text(
          `${gstPercent}%`,
          tableColumns.gstPercent.x,
          currentY,
          {
            width:
              tableColumns.gstPercent.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // GST AMOUNT
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedGstAmount}`,
          tableColumns.gstAmount.x,
          currentY,
          {
            width:
              tableColumns.gstAmount.width,
            align: "right"
          }
        );

        // -----------------------------------------------------
        // AMOUNT
        // -----------------------------------------------------

        doc.text(
          `${currencySymbol}${formattedAmount}`,
          tableColumns.amount.x,
          currentY,
          {
            width:
              tableColumns.amount.width,
            align: "right"
          }
        );

        currentY +=
          rowHeight + 10;
      }
    );

    // =========================================================
    // TOTALS
    // =========================================================

    currentY += 10;

    const formattedSubtotal =
      formatCurrencyAmount(
        subtotal,
        currency
      );

    const formattedCgst =
      formatCurrencyAmount(
        cgstAmount,
        currency
      );

    const formattedSgst =
      formatCurrencyAmount(
        sgstAmount,
        currency
      );

    const formattedIgst =
      formatCurrencyAmount(
        igstAmount,
        currency
      );

    const formattedTotalGst =
      formatCurrencyAmount(
        totalGstAmount,
        currency
      );

    const formattedGrandTotal =
      formatCurrencyAmount(
        grandTotal,
        currency
      );

    // ---------------------------------------------------------
    // TOTALS POSITION
    // ---------------------------------------------------------

    const totalsX =
      pageWidth - 220;

    const totalsValueX =
      pageWidth - 105;

    const totalsValueWidth =
      105;

    // ---------------------------------------------------------
    // CHECK SPACE
    // ---------------------------------------------------------

    const estimatedTotalsHeight =
      gstType === "INTRA_STATE"
        ? 125
        : gstType === "INTER_STATE"
          ? 105
          : 85;

    if (
      currentY +
        estimatedTotalsHeight >
      700
    ) {

      doc.addPage();

      currentY += 10;
    }

    // ---------------------------------------------------------
    // TOTAL WITHOUT GST
    // ---------------------------------------------------------

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        "Total Without GST:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedSubtotal}`,
        totalsValueX,
        currentY,
        {
          width: totalsValueWidth,
          align: "right"
        }
      );

    currentY += 18;

    // ---------------------------------------------------------
    // CGST + SGST
    // ---------------------------------------------------------

    if (
      gstType === "INTRA_STATE"
    ) {

      // CGST

      doc
        .text(
          "CGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedCgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;

      // SGST

      doc
        .text(
          "SGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedSgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;
    }

    // ---------------------------------------------------------
    // IGST
    // ---------------------------------------------------------

    if (
      gstType === "INTER_STATE"
    ) {

      doc
        .text(
          "IGST:",
          totalsX,
          currentY,
          {
            width: 110,
            align: "left"
          }
        )
        .text(
          `${currencySymbol}${formattedIgst}`,
          totalsValueX,
          currentY,
          {
            width:
              totalsValueWidth,
            align: "right"
          }
        );

      currentY += 18;
    }

    // ---------------------------------------------------------
    // TOTAL GST
    // ---------------------------------------------------------

    doc
      .font("Helvetica-Bold")
      .text(
        "Total GST:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedTotalGst}`,
        totalsValueX,
        currentY,
        {
          width:
            totalsValueWidth,
          align: "right"
        }
      );

    currentY += 12;

    // ---------------------------------------------------------
    // LINE BEFORE GRAND TOTAL
    // ---------------------------------------------------------

    doc
      .moveTo(
        totalsX,
        currentY
      )
      .lineTo(
        pageWidth,
        currentY
      )
      .stroke();

    currentY += 12;

    // ---------------------------------------------------------
    // GRAND TOTAL
    // ---------------------------------------------------------

    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(
        "GRAND TOTAL:",
        totalsX,
        currentY,
        {
          width: 110,
          align: "left"
        }
      )
      .text(
        `${currencySymbol}${formattedGrandTotal}`,
        totalsValueX,
        currentY,
        {
          width:
            totalsValueWidth,
          align: "right"
        }
      );

    currentY += 20;

    // Bottom line

    doc
      .moveTo(
        totalsX,
        currentY
      )
      .lineTo(
        pageWidth,
        currentY
      )
      .stroke();

    currentY += 20;

    // =========================================================
    // AMOUNT IN WORDS
    // =========================================================

    const wordsHeight =
      doc.heightOfString(
        amountWords,
        {
          width:
            pageWidth - leftColumn
        }
      );

    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(
        `Amount in Words: ${amountWords}`,
        leftColumn,
        currentY,
        {
          width:
            pageWidth - leftColumn
        }
      );

    currentY +=
      wordsHeight + 20;

    // =========================================================
    // BANK ACCOUNT DETAILS
    // =========================================================

    if (
      company.accountNo ||
      company.bank ||
      company.ifsc
    ) {

      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text(
          "Account Details",
          leftColumn,
          currentY
        );

      currentY += 15;

      let accountY =
        currentY;

      const colonX =
        leftColumn + 80;

      const valueX =
        colonX + 10;

      const lineHeight = 12;

      // Bank

      if (company.bank) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Bank",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.bank,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Name

      if (company.accountName) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account Name",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountName,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Number

      if (company.accountNo) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account No",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountNo.toString(),
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // IFSC

      if (company.ifsc) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "IFSC Code",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.ifsc,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Account Type

      if (company.accountType) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Account Type",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.accountType,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      // Branch

      if (company.branch) {

        doc
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(
            "Branch",
            leftColumn + 10,
            accountY
          );

        doc
          .font("Helvetica-Bold")
          .text(
            ":",
            colonX,
            accountY
          );

        doc
          .font("Helvetica")
          .text(
            company.branch,
            valueX,
            accountY
          );

        accountY +=
          lineHeight;
      }

      currentY =
        accountY + 10;
    }

    // =========================================================
    // OTHER COMMENTS
    // =========================================================

    if (
      invoice.notes &&
      invoice.notes.trim() !== ""
    ) {

      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(
          "OTHER COMMENTS",
          leftColumn,
          currentY
        );

      currentY += 15;

      const sentences =
        invoice.notes
          .split(".")
          .map(
            (s) => s.trim()
          )
          .filter(
            (s) => s.length > 0
          );

      doc
        .fontSize(10)
        .font("Helvetica");

      sentences.forEach(
        (sentence) => {

          const bulletText =
            `• ${sentence}.`;

          const textHeight =
            doc.heightOfString(
              bulletText,
              {
                width: 500
              }
            );

          doc.text(
            bulletText,
            leftColumn + 10,
            currentY,
            {
              width: 500
            }
          );

          currentY +=
            textHeight + 5;
        }
      );
    }

    // =========================================================
    // TERMS & CONDITIONS
    // =========================================================

    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(
        "Terms & Conditions",
        leftColumn,
        currentY
      );

    currentY += 15;

    // Payment terms

    const paymentTerms =
      customer.paymentTerms !== undefined &&
      customer.paymentTerms !== null
        ? customer.paymentTerms
        : 0;

    const paymentDueText =
      `• Total payment due in ${paymentTerms} days.`;

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        paymentDueText,
        leftColumn + 10,
        currentY
      );

    currentY += 15;

    // Default comment

    doc
      .text(
        "• Please include the invoice number on your check.",
        leftColumn + 10,
        currentY
      );

    currentY += 20;

    // =========================================================
    // SIGNATURE
    // =========================================================

    const signatureY = 680;

    const signatureX =
      pageWidth - 125;

    const signatureWidth = 100;

    const signatureHeight = 50;

    if (signatureBuffer) {

      try {

        doc.image(
          signatureBuffer,
          signatureX - 20,
          signatureY - 55,
          {
            width:
              signatureWidth,

            height:
              signatureHeight
          }
        );

        console.log(
          "✅ Signature added to PDF"
        );

      } catch (signatureError) {

        console.error(
          "❌ Error adding signature to PDF:",
          signatureError.message
        );
      }
    }

    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        "For Zynith IT Solutions",
        signatureX - 40,
        signatureY + 5,
        {
          width: 150,
          align: "center"
        }
      );

    // =========================================================
    // FINAL FOOTER
    // =========================================================

    addFinalFooter();

    // =========================================================
    // END PDF
    // =========================================================

    doc.end();

    console.log(
      "✅ PDF generated successfully:",
      invoice.invoiceNumber
    );

  } catch (error) {

    console.error(
      "❌ Error downloading invoice:",
      error
    );

    console.error(
      "❌ Error stack:",
      error.stack
    );

    if (!res.headersSent) {
      return res.status(500).json({
        message:
          "Error downloading invoice",

        error:
          error.message,

        stack:
          process.env.NODE_ENV === "development"
            ? error.stack
            : undefined
      });
    }
  }
};

// Get all invoices
export const getInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find()
      .populate("customerId", "name email phone")
      .sort({ date: -1 });
    res.json(invoices);
  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({ message: "Error fetching invoices", error: error.message });
  }
};

// Get active invoices (non-disabled)
export const getActiveInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find({ isDisabled: false })
      .populate("customerId", "name email phone")
      .sort({ date: -1 });
    res.json(invoices);
  } catch (error) {
    console.error("Error fetching active invoices:", error);
    res.status(500).json({ message: "Error fetching invoices", error: error.message });
  }
};

// Get disabled invoices
export const getDisabledInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find({ isDisabled: true })
      .populate("customerId", "name email phone")
      .sort({ date: -1 });
    res.json(invoices);
  } catch (error) {
    console.error("Error fetching disabled invoices:", error);
    res.status(500).json({ message: "Error fetching disabled invoices", error: error.message });
  }
};

// Get invoice by ID
export const getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate("customerId");
   
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }
    res.json(invoice);
  } catch (error) {
    console.error("Error fetching invoice:", error);
    res.status(500).json({ message: "Error fetching invoice", error: error.message });
  }
};
// Disable invoice (soft delete) - FIXED WITH UPPERCASE STATUS CHECK
export const disableInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('🔄 Attempting to disable invoice:', id);

    // ✅ CHECK IF INVOICE EXISTS
    const existingInvoice = await Invoice.findById(id);
    if (!existingInvoice) {
      console.log('❌ Invoice not found:', id);
      return res.status(404).json({ 
        message: "Invoice not found" 
      });
    }

    console.log('📋 Invoice found:', {
      id: existingInvoice._id,
      invoiceNumber: existingInvoice.invoiceNumber,
      status: existingInvoice.status,
      isDisabled: existingInvoice.isDisabled
    });

    // ✅ CHECK IF INVOICE IS ALREADY PAID - PREVENT DISABLING (USING UPPERCASE)
    if (existingInvoice.status === "paid") {
      console.log('❌ Cannot disable paid invoice:', existingInvoice.invoiceNumber);
      return res.status(400).json({ 
        message: "Cannot disable invoice that has been paid. Paid invoices cannot be disabled." 
      });
    }

    // ✅ CHECK IF INVOICE IS ALREADY DISABLED
    if (existingInvoice.isDisabled) {
      console.log('ℹ️ Invoice already disabled:', existingInvoice.invoiceNumber);
      return res.status(400).json({ 
        message: "Invoice is already disabled." 
      });
    }

    // Disable the invoice
    const invoice = await Invoice.findByIdAndUpdate(
      id,
      {
        isDisabled: true,
        deleted: true,
        disabledAt: new Date()
      },
      { new: true }
    ).populate("customerId");

    console.log('✅ Invoice disabled successfully:', invoice.invoiceNumber);

    res.json({
      message: "Invoice moved to disabled invoices successfully",
      invoice: {
        id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        isDisabled: invoice.isDisabled
      }
    });

  } catch (error) {
    console.error("❌ Error disabling invoice:", error);
    
    // Handle specific MongoDB errors
    if (error.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid invoice ID format" 
      });
    }
    
    res.status(500).json({ 
      message: "Error disabling invoice", 
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

// Permanently delete invoice
export const permanentDeleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
   
    const invoice = await Invoice.findOne({ _id: id, isDisabled: true });
    if (!invoice) {
      return res.status(404).json({ message: "Disabled invoice not found" });
    }

    // ✅ CHECK IF INVOICE IS PAID - PREVENT DELETION
    if (invoice.status === "paid") {
      return res.status(400).json({ 
        message: "Cannot delete invoice that has been paid. Paid invoices cannot be permanently deleted." 
      });
    }

    if (invoice.paymentDetails?.proofFile?.fileName || invoice.paymentDetails?.proofFile?.fileUrl) {
      try {
        const objectKey = invoice.paymentDetails.proofFile.fileName;
        if (objectKey && !objectKey.startsWith('http')) {
          await deleteFromS3({ key: objectKey });
        }
      } catch (fileError) {
        console.error("Error deleting payment proof file:", fileError);
      }
    }

    await Invoice.findByIdAndDelete(id);
   
    res.json({ message: "Invoice permanently deleted successfully" });
  } catch (error) {
    console.error("Error permanently deleting invoice:", error);
    res.status(500).json({ message: "Error deleting invoice", error: error.message });
  }
};

// Enhanced function to handle payment verification with file upload and storage
export const verifyPayment = async (req, res) => {
  try {
    const { invoiceId, transactionNumber } = req.body;
    const transactionProof = req.file; // Get uploaded file
   
    // Validate required fields
    if (!invoiceId || !transactionNumber) {
      return res.status(400).json({ message: "Invoice ID and transaction number are required" });
    }

    if (!transactionProof) {
      return res.status(400).json({ message: "Transaction proof file is required" });
    }

    // Validate file type
    const allowedMimeTypes = [
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
   
    if (!allowedMimeTypes.includes(transactionProof.mimetype)) {
      return res.status(400).json({
        message: "Invalid file type. Supported formats: PDF, JPG, PNG, DOC"
      });
    }

    // Validate file size (10MB max)
    if (transactionProof.size > 10 * 1024 * 1024) {
      return res.status(400).json({
        message: "File size too large. Maximum size is 10MB."
      });
    }

    const fileExtension = path.extname(transactionProof.originalname);
    const uniqueFileName = `payment-proof-${invoiceId}-${Date.now()}${fileExtension}`;

    const s3Object = await uploadToS3({
      buffer: transactionProof.buffer,
      originalName: uniqueFileName,
      mimetype: transactionProof.mimetype,
      folder: 'payment-proofs',
      type: 'invoice-proof'
    });

    const fileUrl = s3Object.url;

    const updatedInvoice = await Invoice.findByIdAndUpdate(
      invoiceId,
      {
        status: "paid",
        $set: {
          "paymentDetails.transactionNumber": transactionNumber,
          "paymentDetails.verifiedAt": new Date(),
          "paymentDetails.proofFile": {
            originalName: transactionProof.originalname,
            mimeType: transactionProof.mimetype,
            size: transactionProof.size,
            uploadedAt: new Date(),
            fileName: s3Object.key,
            filePath: s3Object.key,
            fileUrl: fileUrl
          }
        }
      },
      { new: true, runValidators: true }
    ).populate("customerId");

    if (!updatedInvoice) {
      await deleteFromS3({ key: s3Object.key }).catch(() => {});
      return res.status(404).json({ message: "Invoice not found" });
    }

    // ✅ CREATE TRANSACTION ENTRY AUTOMATICALLY
    try {
      await createTransactionForPaidInvoice(updatedInvoice, transactionNumber);
      console.log(`✅ Transaction history created for invoice: ${updatedInvoice.invoiceNumber}`);
    } catch (transactionError) {
      console.error("⚠️ Invoice paid but failed to create transaction:", transactionError);
      // Don't fail the whole request if transaction creation fails
    }

    res.json({
      message: "Payment verified successfully",
      invoice: updatedInvoice
    });

  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ message: "Error verifying payment", error: error.message });
  }
};
// Restore disabled invoice
export const restoreInvoice = async (req, res) => {
  try {
    const { id } = req.params;
   
    const invoice = await Invoice.findByIdAndUpdate(
      id,
      {
        isDisabled: false,
        deleted: false
      },
      { new: true }
    ).populate("customerId");

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.json({
      message: "Invoice restored successfully",
      invoice
    });
  } catch (error) {
    console.error("Error restoring invoice:", error);
    res.status(500).json({ message: "Error restoring invoice", error: error.message });
  }
};
// ============================================================
// EXPORT INVOICE REPORT TO EXCEL
// ============================================================

export const exportInvoiceExcel = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    console.log("📊 Invoice Excel export requested:", {
      startDate,
      endDate
    });

    // ---------------------------------------------------------
    // VALIDATION
    // ---------------------------------------------------------

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required"
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Make sure the dates are valid
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid date range"
      });
    }

    // ---------------------------------------------------------
    // START DATE = 00:00:00
    // ---------------------------------------------------------

    start.setHours(0, 0, 0, 0);

    // ---------------------------------------------------------
    // END DATE = 23:59:59
    // ---------------------------------------------------------

    end.setHours(23, 59, 59, 999);

    // ---------------------------------------------------------
    // VALIDATE RANGE
    // ---------------------------------------------------------

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: "Start date cannot be greater than end date"
      });
    }

    // ---------------------------------------------------------
    // FETCH INVOICES
    // ---------------------------------------------------------

    const invoices = await Invoice.find({
      date: {
        $gte: start,
        $lte: end
      },

      // Do not include disabled invoices
      isDisabled: {
        $ne: true
      }
    })
      .populate(
        "customerId",
        "name customerId"
      )
      .sort({
        date: 1,
        invoiceNumber: 1
      });

    console.log(
      `📊 Found ${invoices.length} invoices`
    );

    // ---------------------------------------------------------
    // CREATE WORKBOOK
    // ---------------------------------------------------------

    const workbook =
      new ExcelJS.Workbook();

    workbook.creator =
      "Billing System";

    workbook.created =
      new Date();

    workbook.modified =
      new Date();

    // ---------------------------------------------------------
    // CREATE WORKSHEET
    // ---------------------------------------------------------

    const worksheet =
      workbook.addWorksheet(
        "Invoice Report"
      );

    // ---------------------------------------------------------
    // COLUMN DEFINITIONS
    // ---------------------------------------------------------

    worksheet.columns = [
      {
        header: "Customer Name",
        key: "customerName",
        width: 30
      },
      {
        header: "Invoice No",
        key: "invoiceNumber",
        width: 22
      },
      {
        header: "Invoice Date",
        key: "invoiceDate",
        width: 18
      },
      {
        header: "Amount",
        key: "amount",
        width: 18
      }
    ];

    // ---------------------------------------------------------
    // TITLE
    // ---------------------------------------------------------

    worksheet.insertRow(
      1,
      ["INVOICE REPORT"]
    );

    worksheet.mergeCells(
      "A1:D1"
    );

    worksheet.getCell(
      "A1"
    ).font = {
      bold: true,
      size: 16
    };

    worksheet.getCell(
      "A1"
    ).alignment = {
      horizontal: "center",
      vertical: "middle"
    };

    worksheet.getRow(
      1
    ).height = 25;

    // ---------------------------------------------------------
    // DATE RANGE
    // ---------------------------------------------------------

    worksheet.insertRow(
      2,
      [
        `From: ${startDate}`,
        `To: ${endDate}`
      ]
    );

    worksheet.mergeCells(
      "B2:D2"
    );

    worksheet.getCell(
      "A2"
    ).font = {
      bold: true
    };

    worksheet.getCell(
      "B2"
    ).font = {
      bold: true
    };

    // ---------------------------------------------------------
    // HEADER ROW
    // ---------------------------------------------------------

    const headerRow =
      worksheet.getRow(4);

    headerRow.font = {
      bold: true
    };

    headerRow.alignment = {
      horizontal: "center",
      vertical: "middle"
    };

    headerRow.height = 22;

    // ---------------------------------------------------------
    // HEADER BORDER
    // ---------------------------------------------------------

    headerRow.eachCell(
      (cell) => {

        cell.border = {
          top: {
            style: "thin"
          },
          left: {
            style: "thin"
          },
          bottom: {
            style: "thin"
          },
          right: {
            style: "thin"
          }
        };

      }
    );

    // ---------------------------------------------------------
    // TOTAL
    // ---------------------------------------------------------

    let totalAmount = 0;

    // ---------------------------------------------------------
    // ADD INVOICES
    // ---------------------------------------------------------

    invoices.forEach(
      (invoice) => {

        const customerName =
          invoice.customerId?.name ||
          "N/A";

        const invoiceNumber =
          invoice.invoiceNumber ||
          "N/A";

        const invoiceDate =
          invoice.date
            ? new Date(
                invoice.date
              )
            : null;

        const amount =
          Number(
            invoice.totalAmount
          ) || 0;

        totalAmount += amount;

        const row =
          worksheet.addRow({
            customerName,
            invoiceNumber,
            invoiceDate,
            amount
          });

        // -----------------------------------------------------
        // DATE FORMAT
        // -----------------------------------------------------

        row.getCell(
          "invoiceDate"
        ).numFmt =
          "dd-mm-yyyy";

        // -----------------------------------------------------
        // AMOUNT FORMAT
        // -----------------------------------------------------

        row.getCell(
          "amount"
        ).numFmt =
          '#,##0.00';

        // -----------------------------------------------------
        // BORDERS
        // -----------------------------------------------------

        row.eachCell(
          (cell) => {

            cell.border = {
              top: {
                style: "thin"
              },
              left: {
                style: "thin"
              },
              bottom: {
                style: "thin"
              },
              right: {
                style: "thin"
              }
            };

          }
        );
      }
    );

    // ---------------------------------------------------------
    // TOTAL ROW
    // ---------------------------------------------------------

    const totalRow =
      worksheet.addRow({
        customerName: "TOTAL",
        invoiceNumber: "",
        invoiceDate: "",
        amount: totalAmount
      });

    totalRow.font = {
      bold: true
    };

    totalRow.getCell(
      "amount"
    ).numFmt =
      '#,##0.00';

    totalRow.eachCell(
      (cell) => {

        cell.border = {
          top: {
            style: "thin"
          },
          left: {
            style: "thin"
          },
          bottom: {
            style: "thin"
          },
          right: {
            style: "thin"
          }
        };

      }
    );

    // ---------------------------------------------------------
    // FREEZE HEADER
    // ---------------------------------------------------------

    worksheet.views = [
      {
        state: "frozen",
        ySplit: 4
      }
    ];

    // ---------------------------------------------------------
    // AUTO FILTER
    // ---------------------------------------------------------

    worksheet.autoFilter = {
      from: "A4",
      to: "D4"
    };

    // ---------------------------------------------------------
    // RESPONSE HEADERS
    // ---------------------------------------------------------

    const fileName =
      `invoice-report-${startDate}-to-${endDate}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    // ---------------------------------------------------------
    // WRITE EXCEL TO RESPONSE
    // ---------------------------------------------------------

    await workbook.xlsx.write(
      res
    );

    res.end();

    console.log(
      "✅ Invoice Excel report generated:",
      fileName
    );

  } catch (error) {

    console.error(
      "❌ Error generating invoice Excel:",
      error
    );

    if (!res.headersSent) {

      return res.status(500).json({
        success: false,
        message:
          "Error generating invoice Excel report",
        error:
          error.message
      });
    }
  }
};