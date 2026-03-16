// API Configuration
export const API_BASE_URL = 'http://localhost:5000';
// export const API_BASE_URL = 'https://your-production-api.com';

// API Endpoints
export const API_ENDPOINTS = {
  REGISTER: '/api/bda-attendance/register',
  MY_MEETINGS: '/api/bda-attendance/my-meetings',
  REPORT_JOIN: '/api/bda-attendance/report-join',
  REPORT_LEAVE: '/api/bda-attendance/report-leave',
  MANUAL_MARK: '/api/bda-attendance/manual-mark',
  MARK_ABSENT: '/api/bda-attendance/mark-absent',
  SSE: '/api/bda-attendance/sse'
};

// Full API URLs
export const API_URLS = {
  REGISTER: `${API_BASE_URL}${API_ENDPOINTS.REGISTER}`,
  MY_MEETINGS: `${API_BASE_URL}${API_ENDPOINTS.MY_MEETINGS}`,
  REPORT_JOIN: `${API_BASE_URL}${API_ENDPOINTS.REPORT_JOIN}`,
  REPORT_LEAVE: `${API_BASE_URL}${API_ENDPOINTS.REPORT_LEAVE}`,
  MANUAL_MARK: `${API_BASE_URL}${API_ENDPOINTS.MANUAL_MARK}`,
  MARK_ABSENT: `${API_BASE_URL}${API_ENDPOINTS.MARK_ABSENT}`,
  SSE: `${API_BASE_URL}${API_ENDPOINTS.SSE}`
};
