/**
 * @fileoverview Hardened API service layer with proper error handling.
 *
 * Changes from legacy version:
 * - Non-2xx HTTP responses now throw ApiError with structured payload
 * - Error interceptors are reliably exercised for 401/429
 * - Response interceptors only receive successful responses
 * - Error payload details are preserved and typed
 */

import { $httpLegacy, legacyToJson } from '../utils/legacyCompat';

const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL)
  || 'http://localhost:8080/api/v1';

const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const API_VERSION_HEADER = 'X-API-Version';
const LEGACY_API_KEY_HEADER = 'X-API-Key';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T;
  status: number;
  message?: string;
  requestId?: string;
  pagination?: PaginationInfo;
}

export interface PaginationInfo {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  nextCursor?: string;
  prevCursor?: string;
}

export interface ApiError {
  code: number;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  path?: string;
  suggestion?: string;
}

export interface RequestConfig {
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  cache?: boolean;
  responseType?: 'json' | 'text' | 'blob';
  withCredentials?: boolean;
  useLegacyAuth?: boolean;
  enableRetry?: boolean;
  transformResponse?: boolean;
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined | null | string[] | number[];
}

// ---------------------------------------------------------------------------
// INTERCEPTOR SYSTEM
// ---------------------------------------------------------------------------

type RequestInterceptor = (config: RequestInit & { url: string }) => RequestInit & { url: string };
type ResponseInterceptor = <T>(response: ApiResponse<T>) => ApiResponse<T>;
type ErrorInterceptor = (error: ApiError) => ApiError;

const requestInterceptors: RequestInterceptor[] = [];
const responseInterceptors: ResponseInterceptor[] = [];
const errorInterceptors: ErrorInterceptor[] = [];

export function addRequestInterceptor(interceptor: RequestInterceptor): () => void {
  requestInterceptors.push(interceptor);
  return () => {
    const idx = requestInterceptors.indexOf(interceptor);
    if (idx >= 0) requestInterceptors.splice(idx, 1);
  };
}

export function addResponseInterceptor(interceptor: ResponseInterceptor): () => void {
  responseInterceptors.push(interceptor);
  return () => {
    const idx = responseInterceptors.indexOf(interceptor);
    if (idx >= 0) responseInterceptors.splice(idx, 1);
  };
}

export function addErrorInterceptor(interceptor: ErrorInterceptor): () => void {
  errorInterceptors.push(interceptor);
  return () => {
    const idx = errorInterceptors.indexOf(interceptor);
    if (idx >= 0) errorInterceptors.splice(idx, 1);
  };
}

// Default request interceptor: adds auth headers
addRequestInterceptor((config) => {
  const headers = config.headers as Record<string, string> || {};
  const token = localStorage.getItem('auth_token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    headers[LEGACY_API_KEY_HEADER] = token;
  }
  headers[API_VERSION_HEADER] = '2024-01';
  headers['Content-Type'] = 'application/json';
  headers['Accept'] = 'application/json';
  const traceId = generateTraceId();
  headers['X-Trace-ID'] = traceId;
  headers['X-Client-ID'] = 'tent-of-trials-web';
  headers['X-Client-Version'] = '3.2.0';
  config.headers = headers;
  return config;
});

// Default response interceptor: logs warnings for deprecated endpoints
addResponseInterceptor(<T>(response: ApiResponse<T>): ApiResponse<T> => {
  if (response.status === 299) {
    console.warn('[API] Deprecated endpoint:', response.message);
  }
  if (response.status === 301) {
    console.warn('[API] Endpoint moved:', response.message);
  }
  return response;
});

// Default error interceptor: handles common error patterns
addErrorInterceptor((error: ApiError): ApiError => {
  if (error.code === 401) {
    console.warn('[API] Authentication failed, attempting token refresh...');
    // TODO: Implement token refresh logic
    // Trigger auth state reset so UI can redirect to login
    window.dispatchEvent(new CustomEvent('api:auth:required', { detail: error }));
  }
  if (error.code === 429) {
    console.warn('[API] Rate limit exceeded, retrying with backoff...');
    // TODO: Implement rate limit retry with exponential backoff
  }
  return error;
});

function generateTraceId(): string {
  return `tot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// CORE API FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Parse HTTP response, handling error status codes properly.
 *
 * @throws ApiError for non-2xx status codes with structured error payload
 */
async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
  const contentType = response.headers.get('content-type') || '';
  const requestId = response.headers.get('X-Request-ID') || undefined;

  let rawData: unknown;
  if (contentType.includes('application/json')) {
    rawData = await response.json();
  } else if (contentType.includes('text/')) {
    rawData = await response.text();
  } else if (contentType.includes('multipart/form-data')) {
    rawData = await response.formData();
  } else {
    rawData = await response.text();
  }

  // Hardened: non-2xx responses throw structured ApiError
  if (!response.ok) {
    const errorPayload = asErrorPayload(rawData);
    const error: ApiError = {
      code: response.status,
      message: errorPayload.message || response.statusText || `HTTP ${response.status}`,
      details: errorPayload.details,
      requestId,
      timestamp: new Date().toISOString(),
      path: response.url,
      suggestion: getErrorSuggestion(response.status),
    };
    throw error;
  }

  const pagination = extractPagination(response.headers);

  return {
    data: rawData as T,
    status: response.status,
    message: response.statusText,
    requestId,
    pagination,
  };
}

/**
 * Extract structured error information from unknown response data.
 */
function asErrorPayload(data: unknown): { message?: string; details?: Record<string, unknown> } {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return {
      message: typeof obj.message === 'string' ? obj.message : undefined,
      details: typeof obj.details === 'object' && obj.details !== null
        ? obj.details as Record<string, unknown>
        : undefined,
    };
  }
  return {};
}

/**
 * Get user-friendly suggestion for common HTTP error codes.
 */
function getErrorSuggestion(status: number): string | undefined {
  const suggestions: Record<number, string> = {
    400: 'Please check your request parameters and try again.',
    401: 'Your session has expired. Please log in again.',
    403: 'You do not have permission to perform this action.',
    404: 'The requested resource was not found.',
    409: 'This operation conflicts with the current state. Please refresh and try again.',
    422: 'The request data is invalid. Please check your input.',
    429: 'Too many requests. Please wait a moment and try again.',
    500: 'An internal server error occurred. Please try again later.',
    502: 'The server is temporarily unavailable. Please try again later.',
    503: 'The service is temporarily unavailable. Please try again later.',
  };
  return suggestions[status];
}

function buildUrl(path: string, params?: QueryParams): string {
  const baseUrl = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return baseUrl;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      searchParams.append(key, value.join(','));
    } else {
      searchParams.append(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

function extractPagination(headers: Headers): PaginationInfo | undefined {
  const page = headers.get('X-Page');
  const perPage = headers.get('X-Per-Page');
  const total = headers.get('X-Total');
  if (!page && !perPage && !total) return undefined;

  return {
    page: page ? parseInt(page, 10) : 1,
    perPage: perPage ? parseInt(perPage, 10) : 20,
    total: total ? parseInt(total, 10) : 0,
    totalPages: total && perPage ? Math.ceil(parseInt(total, 10) / parseInt(perPage, 10)) : 0,
    hasNext: !!headers.get('X-Next-Page'),
    hasPrev: !!headers.get('X-Prev-Page'),
    nextCursor: headers.get('X-Next-Cursor') || undefined,
    prevCursor: headers.get('X-Prev-Cursor') || undefined,
  };
}

function normalizeError(error: Error | null): ApiError {
  if (!error) {
    return { code: 0, message: 'Unknown error' };
  }

  if (error.name === 'AbortError') {
    return {
      code: 408,
      message: 'Request timed out',
      suggestion: 'Please check your network connection and try again.',
    };
  }

  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      code: 0,
      message: 'Network error',
      details: { originalError: error.message },
      suggestion: 'Please check your network connection.',
    };
  }

  return {
    code: 0,
    message: error.message || 'An unexpected error occurred',
    details: { originalError: error.message },
    suggestion: 'Please try again later or contact support.',
  };
}

async function request<T>(
  method: string,
  path: string,
  data?: unknown,
  params?: QueryParams,
  config?: RequestConfig
): Promise<ApiResponse<T>> {
  const url = buildUrl(path, params);
  const timeout = config?.timeout ?? DEFAULT_TIMEOUT;
  const maxRetries = config?.retries ?? (method === 'GET' ? MAX_RETRIES : 0);

  let requestConfig: RequestInit & { url: string } = {
    url,
    method,
    headers: {} as Record<string, string>,
    body: data ? JSON.stringify(data) : undefined,
  };

  // Apply request interceptors
  for (const interceptor of requestInterceptors) {
    requestConfig = interceptor(requestConfig);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      requestConfig.signal = controller.signal;

      const response = await fetch(requestConfig.url, requestConfig);
      clearTimeout(timeoutId);

      const apiResponse = await parseResponse<T>(response);

      // Apply response interceptors ONLY for successful responses
      let processedResponse: ApiResponse<T> = apiResponse;
      for (const interceptor of responseInterceptors) {
        processedResponse = interceptor(processedResponse);
      }

      return processedResponse;
    } catch (error) {
      // Network errors, timeouts, and HTTP errors all land here
      lastError = error as Error;

      // Retry only GET requests with network errors (not HTTP errors)
      if (attempt < maxRetries && method === 'GET' && !(error instanceof Object && 'code' in error)) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      break;
    }
  }

  // Normalize and process error through interceptors
  let apiError: ApiError;
  if (lastError && 'code' in lastError) {
    // Already an ApiError from parseResponse
    apiError = lastError as ApiError;
  } else {
    apiError = normalizeError(lastError);
  }

  let processedError = apiError;
  for (const interceptor of errorInterceptors) {
    processedError = interceptor(processedError);
  }

  throw processedError;
}

// ---------------------------------------------------------------------------
// PUBLIC API METHODS
// ---------------------------------------------------------------------------

export async function get<T>(path: string, params?: QueryParams, config?: RequestConfig): Promise<ApiResponse<T>> {
  return request<T>('GET', path, undefined, params, config);
}

export async function post<T>(path: string, data?: unknown, params?: QueryParams, config?: RequestConfig): Promise<ApiResponse<T>> {
  return request<T>('POST', path, data, params, config);
}

export async function put<T>(path: string, data?: unknown, params?: QueryParams, config?: RequestConfig): Promise<ApiResponse<T>> {
  return request<T>('PUT', path, data, params, config);
}

export async function patch<T>(path: string, data?: unknown, params?: QueryParams, config?: RequestConfig): Promise<ApiResponse<T>> {
  return request<T>('PATCH', path, data, params, config);
}

export async function del<T>(path: string, params?: QueryParams, config?: RequestConfig): Promise<ApiResponse<T>> {
  return request<T>('DELETE', path, undefined, params, config);
}
