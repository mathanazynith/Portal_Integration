import mongoose from "mongoose";
import { parsePhoneNumberFromString } from 'libphonenumber-js';
 
const companySchema = new mongoose.Schema({
  companyName: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
    default: 'Zynith IT Solutions'
  },
  address: {
    type: String,
    required: [true, 'Company address is required'],
    trim: true
  },
  phone: {
    type: String,
    trim: true,
    validate: {
      validator: function (phone) {
        if (!phone) return true;
        const phoneNumber = parsePhoneNumberFromString(phone);
        return phoneNumber && phoneNumber.isValid();
      },
      message: 'Please enter a valid international phone number'
    }
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    validate: {
      validator: function (email) {
        if (!email) return true;
        const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
        return emailRegex.test(email);
      },
      message: 'Please enter a valid email address'
    }
  },
  website: {
    type: String,
    trim: true,
    validate: {
      validator: function (website) {
        if (!website) return true;
        const urlRegex = /^https?:\/\/.+\..+/;
        return urlRegex.test(website);
      },
      message: 'Please enter a valid website URL'
    }
  },
  gstNumber: { type: String, default: '' ,trim: true},
  currency: {
    type: String,
    enum: ['USD', 'EURO', 'GBP', 'INR', 'CAD', 'AUD'],
    default: 'USD'
  },
  fiscalYear: {
    type: String,
    enum: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ],
    default: 'January'
  },
    // Add these new fields for logo and signature
  logo: {
    public_id: { type: String, default: '' },
  },
  signature: {
    public_id: { type: String, default: '' },
  },
  
  accountNo: {
    type: Number,
    trim: true,
    validate: {
      validator: function (v) {
        return /^[0-9]{6,18}$/.test(v);
      },
      message: "Account Number must be between 6 and 18 digits"
    }
  },

  accountName: {
    type: String,
    trim: true,
  },

  bank: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        return /^[A-Za-z ]+$/.test(v);
      },
      message: "Bank name should contain only alphabets"
    }
  },

  ifsc: {
    type: String,
    trim: true,
    uppercase: true,
    validate: {
      validator: function (v) {
        if (!v) return true;
        // IFSC Format: ABCD0XXXXXX
        return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v);
      },
      message: "Please enter a valid IFSC code (Example: HDFC0001234)"
    }
  },

  accountType: {
    type: String,
    enum: ['Savings', 'Current', 'Salary', 'NRE', 'NRO', 'Other'],
    default: 'Savings'
  }

}, { timestamps: true });

 
companySchema.statics.getCompany = async function () {
  let company = await this.findOne();
  if (!company) {
    company = await this.create({});
  }
  return company;
};
 
const Company = mongoose.model("Company", companySchema);
export default Company;
 