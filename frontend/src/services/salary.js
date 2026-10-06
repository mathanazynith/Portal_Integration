import api from './api';

const extractFilenameFromContentDisposition = (contentDisposition) => {
  if (!contentDisposition) return '';

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1].replace(/['"]/g, ''));
  }

  const standardMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  if (standardMatch) {
    return standardMatch[1];
  }

  return '';
};

export const salaryService = {
  async getEmployeesForSalary() {
    try {
      const response = await api.get('/salaries/employees');
      return response.data;
    } catch (error) {
      console.error('Error fetching employees:', error);
      throw error;
    }
  }, 
 
  // Get employee details by ID
  async getEmployeeDetails(employeeId) {
    try {
      const response = await api.get(`/salaries/employee/${employeeId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching employee details:', error);
      throw error;
    }
  },
 
  // Get employee salary history
  async getEmployeeSalaries(employeeId) {
    try {
      const response = await api.get(`/salaries/employee/${employeeId}/salaries`);
      return response.data;
    } catch (error) {
      console.error('Error getting employee salaries:', error);
      // Fallback to filtering all salaries if specific endpoint fails
      try {
        const allSalaries = await this.getSalaries();
        const employeeSalaries = allSalaries.salaries.filter(
          salary => salary.employeeId === employeeId
        );
        return { salaries: employeeSalaries };
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
        return { salaries: [] };
      }
    }
  },
 
  // Create salary record
  async createSalary(salaryData) {
    try {
      const response = await api.post('/salaries', salaryData);
      return response.data;
    } catch (error) {
      console.error('Error creating salary:', error);
      throw error;
    }
  },
 
  // Get all salary records
  async getSalaries() {
    try {
      const response = await api.get('/salaries');
      return response.data;
    } catch (error) {
      console.error('Error fetching salaries:', error);
      throw error;
    }
  },
 
  // Get salary by ID
  async getSalaryById(salaryId) {
    try {
      const response = await api.get(`/salaries/${salaryId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching salary by ID:', error);
      throw error;
    }
  },
 
  // Update salary record
  async updateSalary(salaryId, salaryData) {
    try {
      const response = await api.put(`/salaries/${salaryId}`, salaryData);
      return response.data;
    } catch (error) {
      console.error('Error updating salary:', error);
      throw error;
    }
  },
 
  // Delete salary record
  async deleteSalary(salaryId) {
    try {
      const response = await api.delete(`/salaries/${salaryId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting salary:', error);
      throw error;
    }
  },

  async deletePayslip(payslipId) {
    try {
      const response = await api.delete(`/salaries/payslip/${payslipId}`);
      return response.data;
    } catch (error) {
      console.error('Error deleting payslip:', error);
      throw error;
    }
  },
 
  // Generate payslip
  async generatePayslip(salaryId) {
    try {
      const response = await api.post(`/salaries/${salaryId}/generate-payslip`);
      return response.data;
    } catch (error) {
      console.error('Error generating payslip:', error);
      throw error;
    }
  },
 
  // Get payslips for employee
  async getEmployeePayslips(employeeId) {
    try {
      const response = await api.get(`/salaries/payslips/${employeeId}`);
      return response.data;
    } catch (error) {
      console.error('Error fetching employee payslips:', error);
      throw error;
    }
  },
 
  // Download payslip PDF
  async downloadPayslip(payslipId) {
    try {
      const response = await api.get(`/salaries/payslip/${payslipId}/download`, {
        responseType: 'blob'
      });

      const blob = response.data;
      const fileName = extractFilenameFromContentDisposition(
        response.headers?.['content-disposition'] || response.headers?.['Content-Disposition']
      );

      if (fileName) {
        blob.filename = fileName;
      }

      return blob;
    } catch (error) {
      console.error('Error downloading payslip:', error);
      throw error;
    }
  },

  // Get all disabled salary records
  async getDisabledSalaries() {
    try {
      const response = await api.get('/salaries/disabled');
      return response.data;
    } catch (error) {
      console.error('Error fetching disabled salaries:', error);
      throw error;
    }
  },

  // Apply hike to salary
  async applyHike(salaryId, hikeData) {
    try {
      const response = await api.post(`/salaries/${salaryId}/apply-hike`, hikeData);
      return response.data;
    } catch (error) {
      console.error('Error applying hike:', error);
      throw error;
    }
  },

  // Get hike history for employee
async getHikeHistory(employeeId, filters = {}) {
  try {
    const params = new URLSearchParams();
    
    // Add filters - if no filters, get latest hike
    if (filters.latest) {
      params.append('latest', 'true');
    } else {
      if (filters.month) params.append('month', filters.month);
      if (filters.year) params.append('year', filters.year);
    }
    
    const queryString = params.toString();
    const url = `/salaries/employee/${employeeId}/hike-history${queryString ? `?${queryString}` : ''}`;
    
    const response = await api.get(url);
    return response.data;
  } catch (error) {
    console.error('Error fetching hike history:', error);
    throw error;
  }
},
  // check for missing payslips
  async checkMissingPayslips() {
    try {
      const response = await api.post('/salaries/check-missing-payslips');
      return response.data;
    } catch (error) {
      console.error('Error checking missing payslips:', error);
      throw error;
    }
  },

  // Sync active salaries to current calendar month
  async syncCurrentMonth() {
    try {
      const response = await api.post('/salaries/sync-month');
      return response.data;
    } catch (error) {
      console.error('Error syncing current month:', error);
      throw error;
    }
  }
};