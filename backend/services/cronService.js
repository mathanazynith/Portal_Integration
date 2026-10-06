import cron from 'node-cron';
import Salary from '../models/Salary.js';
import Payslip from '../models/Payslip.js';
import { sendPayslipEmail } from './emailService.js';
import axios from 'axios';

const HR_API = process.env.HR_API_URL || 'https://hr.zynith-it.com';

const monthMap = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12
}
/**
 * Start the cron job for processing hike status updates
 * Runs once daily at 01:00 AM (Asia/Kolkata)
 * @returns {void}
 */
export const startHikeCronJob = () => {
  cron.schedule('0 1 * * *', async () => {
    try {
      console.log('🔄 Checking for salary hike status updates...');
      
      const result = await Salary.processHikeStatusUpdates();
      
      if (result.activated > 0 || result.disabled > 0) {
        console.log(`✅ Hike status update completed: ${result.activated} salary records activated, ${result.disabled} salary records disabled`);
      } else {
        console.log('✅ No hike status updates needed');
      }
    } catch (error) {
      console.error('❌ Error processing hike status updates:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  console.log('✅ Hike status cron job scheduled (Daily at 01:00 AM, Asia/Kolkata)');
};

/**
 * Start the cron job for updating salary month on the 1st of every month
 * Updates salary records to show the new active month and resets status to 'pending'
 * @returns {void}
 */
export const startSalaryMonthUpdateJob = () => {
  // Run at 00:05 AM on the 1st of every month
  cron.schedule('5 0 1 * *', async () => {
    try {
      const today = new Date();
      const currentMonthName = today.toLocaleString('default', { month: 'long' });
      const currentYear = today.getFullYear();
      
      console.log(`📅 Starting new month update: ${currentMonthName} ${currentYear}...`);
      
      // Update all salary records with the current new month and reset status
      const result = await Salary.updateMany(
        {}, 
        { 
          $set: { 
            month: currentMonthName,
            year: currentYear,
            status: 'pending'
          } 
        }
      );
      
      console.log(`✅ Salary month updated to "${currentMonthName} ${currentYear}" for ${result.modifiedCount} records`);
    } catch (error) {
      console.error('❌ Error updating salary month:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  console.log('✅ Salary month update cron job scheduled (1st of each month at 00:05 AM, Asia/Kolkata)');
};
// const TESTING_MODE = true; // set to false before going live

export const generatePayslipForSalary = async (salaryId, options = {}) => {
  const { force = false, targetMonth = null, targetYear = null } = options;
  const salary = await Salary.findById(salaryId);
  if (!salary) {
    return { success: false, message: 'Salary record not found' };
  }
  if (salary.activeStatus !== 'enabled') {
    return { success: false, message: 'Payslip cannot be generated for disabled salary records' };
  }

  const finalMonth = targetMonth || salary.month;
  const finalYear = targetYear ? Number(targetYear) : salary.year;

  // 🛡️ Month validation guard
  const monthIndex = monthMap[finalMonth] ? monthMap[finalMonth] - 1 : null;
  if (monthIndex === null) {
    return { success: false, message: `Unrecognized month format: ${finalMonth}` };
  }
  const now = new Date();
  const currentMonthIndex = now.getMonth();
  const currentYear = now.getFullYear();

  // 1. Block future months
  const isFutureMonth =
    finalYear > currentYear ||
    (finalYear === currentYear && monthIndex > currentMonthIndex);
  if (isFutureMonth) {
    return {
      success: false,
      message: `Cannot generate payslip for ${finalMonth} ${finalYear} — that period hasn't started yet`
    };
  }

  const existingPayslip = await Payslip.findOne({
    employeeId: salary.employeeId,
    month: finalMonth,
    year: finalYear
  });

  if (existingPayslip) {
    return { success: false, message: `Payslip already generated for ${finalMonth} ${finalYear}` };
  }

  // Fetch payroll data from HR (graceful fallback)
  let hrData = null;
  try {
    const numericMonth = monthMap[finalMonth] || finalMonth;
    const hrHeaders = process.env.HR_API_TOKEN ? { Authorization: `Bearer ${process.env.HR_API_TOKEN}` } : {};
    const hrResponse = await axios.get(
      `${HR_API}/api/payroll/payroll-data/${salary.employeeId}`,
      { params: { year: finalYear, month: numericMonth }, headers: hrHeaders, timeout: 5000 }
    );
    hrData = hrResponse.data;
  } catch (err) {
    console.warn(`⚠️ HR data fetch skipped for ${salary.employeeId} (${err.response?.data?.error || err.message}). Using salary record values.`);
  }

  // Update salary with leave/LOP data from HR if available and matching current period
  if (hrData && finalMonth === salary.month && finalYear === salary.year) {
    salary.casualLeaveTaken = Number(hrData.casualLeaveTaken) || 0;
    salary.casualLeaveRemaining = Number(hrData.casualLeaveRemaining) || 0;
    salary.sickLeaveTaken = Number(hrData.sickLeaveTaken) || 0;
    salary.sickLeaveRemaining = Number(hrData.sickLeaveRemaining) || 0;
    salary.lopDays = Number(hrData.lopDays) || 0;
    salary.paidDays = Number(hrData.paidDays) || 0;
    await salary.save();
  }

  // Create the payslip record
  const payslip = new Payslip({
    salaryId: salary._id,
    employeeId: salary.employeeId,
    name: salary.name,
    email: salary.email,
    designation: salary.designation,
    panNo: salary.panNo,
    month: finalMonth,
    year: finalYear,
    payDate: new Date().toISOString().split('T')[0],
    basicSalary: salary.basicSalary,
    grossEarnings: salary.grossEarnings,
    totalDeductions: salary.totalDeductions,
    netPay: salary.netPay,
    paidDays: salary.paidDays || 30,
    lopDays: salary.lopDays || 0,
    casualLeaveTaken: salary.casualLeaveTaken || 0,
    casualLeaveRemaining: salary.casualLeaveRemaining || 0,
    sickLeaveTaken: salary.sickLeaveTaken || 0,
    sickLeaveRemaining: salary.sickLeaveRemaining || 0,
    earnings: salary.earnings,
    deductions: salary.deductions
  });
  await payslip.save();

  // Mark salary as paid if generating for current record's period
  if (finalMonth === salary.month && finalYear === salary.year) {
    salary.status = 'paid';
    await salary.save();
  }

  // Send email
  const emailResult = await sendPayslipEmail(payslip);

  return {
    success: true,
    message: 'Payslip generated successfully',
    payslip,
    emailSent: emailResult.success
  };
};

/**
 * Auto-generate payslips for all active salary records that don't already have one.
 * Runs daily at 00:15 AM (right after the 1st of month update at 00:05 AM, and every day for any pending salaries).
 */
export const startAutoPayslipGenerationJob = () => {
  cron.schedule('15 0 * * *', async () => {
    try {
      console.log(`📄 Starting daily auto payslip generation check (${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })})...`);

      const activeSalaries = await Salary.find({ activeStatus: 'enabled' });
      let generated = 0;
      let skipped = 0;

      for (const salary of activeSalaries) {
        const result = await generatePayslipForSalary(salary._id);
        if (result.success) {
          generated++;
          console.log(`✅ Payslip auto-generated for ${salary.employeeId}`);
        } else {
          skipped++;
        }
      }

      console.log(`📊 Auto payslip generation done: ${generated} generated, ${skipped} skipped`);
    } catch (error) {
      console.error('❌ Error in auto payslip generation job:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  console.log('✅ Auto payslip generation cron job scheduled (Daily at 00:15 AM, Asia/Kolkata)');
};

/**
 * Daily safety-net job: checks all enabled salary records and
 * regenerates any missing payslip for completed months.
 * Runs once a day at 2:00 AM IST.
 * @returns {void}
 */
export const startMissingPayslipRecoveryJob = () => {
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('🔍 Checking for missing payslips for completed months...');

      const activeSalaries = await Salary.find({ activeStatus: 'enabled' });
      let restored = 0;
      let skipped = 0;

      for (const salary of activeSalaries) {
        const result = await generatePayslipForSalary(salary._id);
        if (result.success) {
          restored++;
          console.log(`✅ Restored missing payslip for ${salary.employeeId} (${salary.month} ${salary.year})`);
        } else {
          skipped++;
        }
      }

      if (restored > 0) {
        console.log(`📊 Missing payslip recovery check complete: ${restored} restored`);
      }
    } catch (error) {
      console.error('❌ Error in missing payslip recovery job:', error);
    }
  }, {
    timezone: 'Asia/Kolkata'
  });

  console.log('✅ Missing payslip recovery cron job scheduled (Daily at 02:00 AM, Asia/Kolkata)');
};