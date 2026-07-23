import {HttpStatus} from '@nestjs/common';

// Stable, machine-readable error codes. The frontend maps each code to a
// localized message (uz/ru/en); it never displays the English `message` below,
// which is kept only as a developer-facing fallback for logs and for clients
// that have not adopted code-based mapping yet (e.g. the mobile app).
//
// CONTRACT: codes are permanent. Never rename or repurpose one — add a new
// code instead. Keep this enum in sync with the frontend `errors` namespace in
// pimpo-nextjs/src/i18n/messages/*.json.
export enum ErrorCode {
  // ── Generic (filter fallbacks) ─────────────────────────────────────────────
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  // ── Auth / business ────────────────────────────────────────────────────────
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  BUSINESS_INACTIVE = 'BUSINESS_INACTIVE',
  STAFF_INACTIVE = 'STAFF_INACTIVE',
  STAFF_ROLE_INACTIVE = 'STAFF_ROLE_INACTIVE',
  BUSINESS_NOT_FOUND = 'BUSINESS_NOT_FOUND',
  EMAIL_OR_LOGIN_EXISTS = 'EMAIL_OR_LOGIN_EXISTS',
  NO_TOKEN = 'NO_TOKEN',
  AUTH_BUSINESS_INVALID = 'AUTH_BUSINESS_INVALID',
  INVALID_TOKEN = 'INVALID_TOKEN',
  OWNER_ONLY = 'OWNER_ONLY',
  PLATFORM_ADMIN_REQUIRED = 'PLATFORM_ADMIN_REQUIRED',

  // ── Branch ─────────────────────────────────────────────────────────────────
  BRANCH_MAIN_DELETE_FORBIDDEN = 'BRANCH_MAIN_DELETE_FORBIDDEN',
  BRANCH_NOT_FOUND = 'BRANCH_NOT_FOUND',
  BRANCH_LIMIT_REACHED = 'BRANCH_LIMIT_REACHED',

  // ── Units of measure ───────────────────────────────────────────────────────
  UNIT_NOT_FOUND = 'UNIT_NOT_FOUND',
  UNIT_NAME_EXISTS = 'UNIT_NAME_EXISTS',

  // ── Payment methods ────────────────────────────────────────────────────────
  PAYMENT_METHOD_NOT_FOUND = 'PAYMENT_METHOD_NOT_FOUND',
  PAYMENT_METHOD_NAME_EXISTS = 'PAYMENT_METHOD_NAME_EXISTS',
  PAYMENT_METHOD_SYSTEM_IMMUTABLE = 'PAYMENT_METHOD_SYSTEM_IMMUTABLE',

  // ── Plan / feature gating ──────────────────────────────────────────────────
  PLAN_UPGRADE_REQUIRED = 'PLAN_UPGRADE_REQUIRED',

  // ── Brand ──────────────────────────────────────────────────────────────────
  BRAND_NOT_FOUND = 'BRAND_NOT_FOUND',

  // ── Category ───────────────────────────────────────────────────────────────
  CATEGORY_ALREADY_EXISTS = 'CATEGORY_ALREADY_EXISTS',
  CATEGORY_NOT_FOUND = 'CATEGORY_NOT_FOUND',

  // ── Debt ───────────────────────────────────────────────────────────────────
  DEBT_LIMIT_REACHED = 'DEBT_LIMIT_REACHED',
  DEBT_NOT_FOUND = 'DEBT_NOT_FOUND',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  DEBT_USER_INFO_REQUIRED = 'DEBT_USER_INFO_REQUIRED',
  DEBT_INSTALLMENT_PRO_ONLY = 'DEBT_INSTALLMENT_PRO_ONLY',
  DEBT_PAYMENT_AMOUNT_INVALID = 'DEBT_PAYMENT_AMOUNT_INVALID',
  DEBT_PAYMENT_EXCEEDS_BALANCE = 'DEBT_PAYMENT_EXCEEDS_BALANCE',
  DEBT_PAYMENT_NOT_FOUND = 'DEBT_PAYMENT_NOT_FOUND',

  // ── Finance ────────────────────────────────────────────────────────────────
  FINANCE_ACCOUNT_NOT_FOUND = 'FINANCE_ACCOUNT_NOT_FOUND',
  FINANCE_TRANSFER_SAME_ACCOUNT = 'FINANCE_TRANSFER_SAME_ACCOUNT',

  // ── Order ──────────────────────────────────────────────────────────────────
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  SHIFT_NOT_FOUND_FOR_BUSINESS = 'SHIFT_NOT_FOUND_FOR_BUSINESS',
  NO_CASH_REGISTER = 'NO_CASH_REGISTER',
  MULTIPLE_REGISTERS = 'MULTIPLE_REGISTERS',
  NO_OPEN_SHIFT_FOR_REGISTER = 'NO_OPEN_SHIFT_FOR_REGISTER',
  SALES_FROZEN_STOCK_TAKE = 'SALES_FROZEN_STOCK_TAKE',
  CUSTOMER_NOT_FOUND = 'CUSTOMER_NOT_FOUND',
  DEBT_SALE_CUSTOMER_REQUIRED = 'DEBT_SALE_CUSTOMER_REQUIRED',
  PRODUCT_NOT_FOUND_BY_ID = 'PRODUCT_NOT_FOUND_BY_ID',
  ORDER_EMPTY = 'ORDER_EMPTY',
  CASHIER_NOT_FOUND = 'CASHIER_NOT_FOUND',
  HELD_SALE_CHECKOUT_REQUIRED = 'HELD_SALE_CHECKOUT_REQUIRED',
  DEBT_SALE_CUSTOMER_IMMUTABLE = 'DEBT_SALE_CUSTOMER_IMMUTABLE',

  // ── Product ────────────────────────────────────────────────────────────────
  PRODUCT_LIMIT_REACHED = 'PRODUCT_LIMIT_REACHED',
  PRODUCT_BULK_IMPORT_PRO_ONLY = 'PRODUCT_BULK_IMPORT_PRO_ONLY',
  PRODUCT_CODE_EXISTS = 'PRODUCT_CODE_EXISTS',
  PRODUCT_NOT_FOUND = 'PRODUCT_NOT_FOUND',
  BARCODE_QUERY_REQUIRED = 'BARCODE_QUERY_REQUIRED',

  // ── Receipt template ───────────────────────────────────────────────────────
  RECEIPT_TEMPLATE_NOT_FOUND = 'RECEIPT_TEMPLATE_NOT_FOUND',
  RECEIPT_TEMPLATE_DEFAULT_DELETE_FORBIDDEN = 'RECEIPT_TEMPLATE_DEFAULT_DELETE_FORBIDDEN',

  // ── Receipt ────────────────────────────────────────────────────────────────
  RECEIPT_NOT_FOUND = 'RECEIPT_NOT_FOUND',
  SUPPLIER_NOT_FOUND_BY_ID = 'SUPPLIER_NOT_FOUND_BY_ID',
  RECEIPT_USD_RATE_REQUIRED = 'RECEIPT_USD_RATE_REQUIRED',
  RECEIPT_ONLY_DRAFT_RECEIVABLE = 'RECEIPT_ONLY_DRAFT_RECEIVABLE',
  RECEIPT_RECEIVE_BEFORE_PAYMENT = 'RECEIPT_RECEIVE_BEFORE_PAYMENT',
  RECEIPT_RECEIVE_BEFORE_RETURN = 'RECEIPT_RECEIVE_BEFORE_RETURN',
  RECEIPT_NOTHING_TO_RETURN = 'RECEIPT_NOTHING_TO_RETURN',
  RECEIPT_PRODUCT_NOT_ON_RECEIPT = 'RECEIPT_PRODUCT_NOT_ON_RECEIPT',
  RECEIPT_RETURN_EXCEEDS_STOCK = 'RECEIPT_RETURN_EXCEEDS_STOCK',

  // ── Role ───────────────────────────────────────────────────────────────────
  ROLE_NOT_FOUND = 'ROLE_NOT_FOUND',
  ROLE_NAME_EXISTS = 'ROLE_NAME_EXISTS',
  ROLE_ASSIGNED_DELETE_FORBIDDEN = 'ROLE_ASSIGNED_DELETE_FORBIDDEN',

  // ── Shift ──────────────────────────────────────────────────────────────────
  REGISTER_NOT_FOUND = 'REGISTER_NOT_FOUND',
  REGISTER_OPEN_FROZEN_STOCK_TAKE = 'REGISTER_OPEN_FROZEN_STOCK_TAKE',
  REGISTER_ALREADY_OPEN = 'REGISTER_ALREADY_OPEN',
  SHIFT_NOT_FOUND = 'SHIFT_NOT_FOUND',
  SHIFT_ALREADY_CLOSED = 'SHIFT_ALREADY_CLOSED',
  SHIFT_CLOSE_FORBIDDEN = 'SHIFT_CLOSE_FORBIDDEN',

  // ── Staff ──────────────────────────────────────────────────────────────────
  STAFF_ROLE_NOT_FOUND = 'STAFF_ROLE_NOT_FOUND',
  USER_LIMIT_REACHED = 'USER_LIMIT_REACHED',
  STAFF_LOGIN_EXISTS = 'STAFF_LOGIN_EXISTS',
  STAFF_NOT_FOUND = 'STAFF_NOT_FOUND',

  // ── Store (online storefront) ──────────────────────────────────────────────
  STORE_INSUFFICIENT_STOCK = 'STORE_INSUFFICIENT_STOCK',
  ORDER_CANCELLED_IMMUTABLE = 'ORDER_CANCELLED_IMMUTABLE',
  STORE_NOT_FOUND = 'STORE_NOT_FOUND',
  STORE_SLUG_TAKEN = 'STORE_SLUG_TAKEN',
  STORE_SLUG_INVALID = 'STORE_SLUG_INVALID',

  // ── Stock-take ─────────────────────────────────────────────────────────────
  STOCK_TAKE_IN_PROGRESS = 'STOCK_TAKE_IN_PROGRESS',
  STOCK_TAKE_ALREADY_COMPLETED = 'STOCK_TAKE_ALREADY_COMPLETED',
  STOCK_TAKE_NOT_FOUND = 'STOCK_TAKE_NOT_FOUND',
  STOCK_TAKE_NOT_IN_PROGRESS = 'STOCK_TAKE_NOT_IN_PROGRESS',
  RECEIPT_FROZEN_STOCK_TAKE = 'RECEIPT_FROZEN_STOCK_TAKE',
  WRITE_OFF_EMPTY = 'WRITE_OFF_EMPTY',
  WRITE_OFF_EXCEEDS_STOCK = 'WRITE_OFF_EXCEEDS_STOCK',

  // ── Stock transfer (filiallararo ko'chirish) ───────────────────────────────
  TRANSFER_EMPTY = 'TRANSFER_EMPTY',
  TRANSFER_SAME_BRANCH = 'TRANSFER_SAME_BRANCH',
  TRANSFER_EXCEEDS_STOCK = 'TRANSFER_EXCEEDS_STOCK',
  TRANSFER_NOT_FOUND = 'TRANSFER_NOT_FOUND',

  // ── Storage ────────────────────────────────────────────────────────────────
  STORAGE_NOT_CONFIGURED = 'STORAGE_NOT_CONFIGURED',
  NO_FILE_PROVIDED = 'NO_FILE_PROVIDED',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',

  // ── Subscription ───────────────────────────────────────────────────────────
  SUBSCRIPTION_PLAN_NOT_FOUND = 'SUBSCRIPTION_PLAN_NOT_FOUND',
  SUBSCRIPTION_PLAN_TIER_NOT_FOUND = 'SUBSCRIPTION_PLAN_TIER_NOT_FOUND',
  SUBSCRIPTION_CREATE_FAILED = 'SUBSCRIPTION_CREATE_FAILED',
  SUBSCRIPTION_PLAN_TIER_EXISTS = 'SUBSCRIPTION_PLAN_TIER_EXISTS',

  // ── Supplier ───────────────────────────────────────────────────────────────
  SUPPLIER_NOT_FOUND = 'SUPPLIER_NOT_FOUND',

  // ── User ───────────────────────────────────────────────────────────────────
  USER_PHONE_EXISTS = 'USER_PHONE_EXISTS',
}

export interface ErrorDefinition {
  /** HTTP status this code resolves to. Mirrors the original exception's status. */
  status: HttpStatus;
  /**
   * English, developer-facing default. `{placeholder}` tokens are interpolated
   * from the AppException params. Not shown to end users — the frontend
   * localizes by `code`.
   */
  message: string;
}

// Single source of truth: code → { status, default message }.
export const ERROR_REGISTRY: Record<ErrorCode, ErrorDefinition> = {
  // Generic
  [ErrorCode.VALIDATION_ERROR]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Validation failed',
  },
  [ErrorCode.BAD_REQUEST]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Bad request',
  },
  [ErrorCode.UNAUTHORIZED]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Unauthorized',
  },
  [ErrorCode.FORBIDDEN]: {status: HttpStatus.FORBIDDEN, message: 'Forbidden'},
  [ErrorCode.NOT_FOUND]: {status: HttpStatus.NOT_FOUND, message: 'Not found'},
  [ErrorCode.CONFLICT]: {status: HttpStatus.CONFLICT, message: 'Conflict'},
  [ErrorCode.INTERNAL_ERROR]: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Internal server error',
  },

  // Auth / business
  [ErrorCode.INVALID_CREDENTIALS]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Invalid login credentials',
  },
  [ErrorCode.BUSINESS_INACTIVE]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Business account is inactive',
  },
  [ErrorCode.STAFF_INACTIVE]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Staff account is inactive',
  },
  [ErrorCode.STAFF_ROLE_INACTIVE]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Staff role is missing or inactive',
  },
  [ErrorCode.BUSINESS_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Business not found',
  },
  [ErrorCode.EMAIL_OR_LOGIN_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Email or login already exists',
  },
  [ErrorCode.NO_TOKEN]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'No token provided',
  },
  [ErrorCode.AUTH_BUSINESS_INVALID]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Business not found or inactive',
  },
  [ErrorCode.INVALID_TOKEN]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Invalid token',
  },
  [ErrorCode.OWNER_ONLY]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the business owner can perform this action',
  },
  [ErrorCode.PLATFORM_ADMIN_REQUIRED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Platform admin access required',
  },

  // Branch
  [ErrorCode.BRANCH_MAIN_DELETE_FORBIDDEN]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The main store cannot be deleted',
  },
  [ErrorCode.BRANCH_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Branch not found',
  },
  [ErrorCode.BRANCH_LIMIT_REACHED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Branch limit reached for your plan',
  },
  [ErrorCode.UNIT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Unit not found',
  },
  [ErrorCode.UNIT_NAME_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'A unit with this name already exists',
  },
  [ErrorCode.PAYMENT_METHOD_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Payment method not found',
  },
  [ErrorCode.PAYMENT_METHOD_NAME_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'A payment method with this name already exists',
  },
  [ErrorCode.PAYMENT_METHOD_SYSTEM_IMMUTABLE]: {
    status: HttpStatus.FORBIDDEN,
    message: 'System payment methods cannot be renamed or deleted',
  },

  // Plan / feature gating
  [ErrorCode.PLAN_UPGRADE_REQUIRED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'This feature requires a higher plan',
  },

  // Brand
  [ErrorCode.BRAND_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Brand not found',
  },

  // Category
  [ErrorCode.CATEGORY_ALREADY_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Category with this id already exists',
  },
  [ErrorCode.CATEGORY_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Category not found',
  },

  // Debt
  [ErrorCode.DEBT_LIMIT_REACHED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Debt limit of {limit} reached for your current plan.',
  },
  [ErrorCode.DEBT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Debt not found',
  },
  [ErrorCode.USER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'User not found',
  },
  [ErrorCode.DEBT_USER_INFO_REQUIRED]: {
    status: HttpStatus.NOT_FOUND,
    message: 'User ID or user name and phone are required',
  },
  [ErrorCode.DEBT_INSTALLMENT_PRO_ONLY]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Installment debt payments are available on the Pro plan.',
  },
  [ErrorCode.DEBT_PAYMENT_AMOUNT_INVALID]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Payment amount must be greater than 0.',
  },
  [ErrorCode.DEBT_PAYMENT_EXCEEDS_BALANCE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Payment exceeds the remaining balance ({remaining}).',
  },
  [ErrorCode.DEBT_PAYMENT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Payment not found',
  },

  // Finance
  [ErrorCode.FINANCE_ACCOUNT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Account not found',
  },
  [ErrorCode.FINANCE_TRANSFER_SAME_ACCOUNT]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Source and destination must differ',
  },

  // Order
  [ErrorCode.ORDER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Order not found',
  },
  [ErrorCode.SHIFT_NOT_FOUND_FOR_BUSINESS]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Shift not found for this business',
  },
  [ErrorCode.NO_CASH_REGISTER]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'No cash register found. Open a cash shift before selling.',
  },
  [ErrorCode.MULTIPLE_REGISTERS]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Multiple registers exist — specify registerId for the sale.',
  },
  [ErrorCode.NO_OPEN_SHIFT_FOR_REGISTER]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'No open cash shift for this register. Open a shift before selling.',
  },
  [ErrorCode.SALES_FROZEN_STOCK_TAKE]: {
    status: HttpStatus.FORBIDDEN,
    message:
      'A stock-take is in progress. Sales are frozen until it is completed.',
  },
  [ErrorCode.CUSTOMER_NOT_FOUND]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Customer not found for this business',
  },
  [ErrorCode.DEBT_SALE_CUSTOMER_REQUIRED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A customer name and phone are required for a debt sale',
  },
  [ErrorCode.PRODUCT_NOT_FOUND_BY_ID]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Product not found: {productId}',
  },
  [ErrorCode.ORDER_EMPTY]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Order must contain at least one item',
  },
  [ErrorCode.CASHIER_NOT_FOUND]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Cashier not found for this business',
  },
  [ErrorCode.HELD_SALE_CHECKOUT_REQUIRED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A held sale must be completed through checkout',
  },
  [ErrorCode.DEBT_SALE_CUSTOMER_IMMUTABLE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The customer of a debt sale cannot be changed',
  },

  // Product
  [ErrorCode.PRODUCT_LIMIT_REACHED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Product limit of {limit} reached for your current plan.',
  },
  [ErrorCode.PRODUCT_BULK_IMPORT_PRO_ONLY]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Bulk import is not available on the free plan.',
  },
  [ErrorCode.PRODUCT_CODE_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Product with this code already exists',
  },
  [ErrorCode.PRODUCT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Product not found',
  },
  [ErrorCode.BARCODE_QUERY_REQUIRED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'barcode query parameter is required',
  },

  // Receipt template
  [ErrorCode.RECEIPT_TEMPLATE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Receipt template not found',
  },
  [ErrorCode.RECEIPT_TEMPLATE_DEFAULT_DELETE_FORBIDDEN]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Cannot delete the default template. Set another as default first.',
  },

  // Receipt
  [ErrorCode.RECEIPT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Receipt not found',
  },
  [ErrorCode.SUPPLIER_NOT_FOUND_BY_ID]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Supplier not found: {supplierId}',
  },
  [ErrorCode.RECEIPT_USD_RATE_REQUIRED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'usdRate is required for a USD receipt',
  },
  [ErrorCode.RECEIPT_ONLY_DRAFT_RECEIVABLE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Only a draft receipt can be received',
  },
  [ErrorCode.RECEIPT_RECEIVE_BEFORE_PAYMENT]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Receive the draft before adding a payment',
  },
  [ErrorCode.RECEIPT_RECEIVE_BEFORE_RETURN]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Receive the draft before returning goods',
  },
  [ErrorCode.RECEIPT_NOTHING_TO_RETURN]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Nothing to return',
  },
  [ErrorCode.RECEIPT_PRODUCT_NOT_ON_RECEIPT]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Product not on this receipt: {productId}',
  },
  [ErrorCode.RECEIPT_RETURN_EXCEEDS_STOCK]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Cannot return {qty} of "{name}"; only {available} left in stock from this receipt',
  },

  // Role
  [ErrorCode.ROLE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Role not found',
  },
  [ErrorCode.ROLE_NAME_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'A role with this name already exists',
  },
  [ErrorCode.ROLE_ASSIGNED_DELETE_FORBIDDEN]: {
    status: HttpStatus.CONFLICT,
    message: 'Cannot delete a role that is still assigned to staff',
  },

  // Shift
  [ErrorCode.REGISTER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Register not found',
  },
  [ErrorCode.REGISTER_OPEN_FROZEN_STOCK_TAKE]: {
    status: HttpStatus.FORBIDDEN,
    message:
      'A stock-take is in progress. The cash register cannot be opened until it is completed.',
  },
  [ErrorCode.REGISTER_ALREADY_OPEN]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This register already has an open shift. Close it first.',
  },
  [ErrorCode.SHIFT_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Shift not found',
  },
  [ErrorCode.SHIFT_ALREADY_CLOSED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Shift is already closed',
  },
  [ErrorCode.SHIFT_CLOSE_FORBIDDEN]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Only the cashier who opened this shift (or an owner) can close it',
  },

  // Staff
  [ErrorCode.STAFF_ROLE_NOT_FOUND]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Role not found for this business',
  },
  [ErrorCode.USER_LIMIT_REACHED]: {
    status: HttpStatus.FORBIDDEN,
    message: 'User limit of {limit} reached for your current plan.',
  },
  [ErrorCode.STAFF_LOGIN_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Login already exists',
  },
  [ErrorCode.STAFF_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Staff not found',
  },

  // Store (online storefront)
  [ErrorCode.STORE_INSUFFICIENT_STOCK]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Cannot order {qty} of "{name}"; only {available} in stock',
  },
  [ErrorCode.ORDER_CANCELLED_IMMUTABLE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A cancelled order cannot change status',
  },
  [ErrorCode.STORE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Store not found',
  },
  [ErrorCode.STORE_SLUG_TAKEN]: {
    status: HttpStatus.CONFLICT,
    message: 'This store address is already taken',
  },
  [ErrorCode.STORE_SLUG_INVALID]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The store address may use only lowercase letters, digits and hyphens (3-63 chars)',
  },

  // Stock-take
  [ErrorCode.STOCK_TAKE_IN_PROGRESS]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Another stock-take is already in progress. Finish it first.',
  },
  [ErrorCode.STOCK_TAKE_ALREADY_COMPLETED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Stock-take is already completed',
  },
  [ErrorCode.STOCK_TAKE_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Stock-take not found',
  },
  [ErrorCode.STOCK_TAKE_NOT_IN_PROGRESS]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Only an in-progress stock-take can be cancelled',
  },
  [ErrorCode.RECEIPT_FROZEN_STOCK_TAKE]: {
    status: HttpStatus.FORBIDDEN,
    message:
      'A stock-take is in progress. Goods receipts are frozen until it is completed.',
  },
  [ErrorCode.WRITE_OFF_EMPTY]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A write-off must contain at least one item',
  },
  [ErrorCode.WRITE_OFF_EXCEEDS_STOCK]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Cannot write off {qty} of "{name}"; only {available} in stock',
  },

  // Stock transfer
  [ErrorCode.TRANSFER_EMPTY]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A transfer must contain at least one item',
  },
  [ErrorCode.TRANSFER_SAME_BRANCH]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Source and destination store must differ',
  },
  [ErrorCode.TRANSFER_EXCEEDS_STOCK]: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Cannot transfer {qty} of "{name}"; only {available} in the source store',
  },
  [ErrorCode.TRANSFER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Transfer not found',
  },

  // Storage
  [ErrorCode.STORAGE_NOT_CONFIGURED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'File storage is not configured.',
  },
  [ErrorCode.NO_FILE_PROVIDED]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'No file provided.',
  },
  [ErrorCode.INVALID_FILE_TYPE]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Invalid file type. Allowed: {allowed}',
  },

  // Subscription
  [ErrorCode.SUBSCRIPTION_PLAN_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Plan with id {planId} not found',
  },
  [ErrorCode.SUBSCRIPTION_PLAN_TIER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Subscription plan with tier {tier} not found',
  },
  [ErrorCode.SUBSCRIPTION_CREATE_FAILED]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Failed to create subscription',
  },
  [ErrorCode.SUBSCRIPTION_PLAN_TIER_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'Plan with tier {tier} already exists',
  },

  // Supplier
  [ErrorCode.SUPPLIER_NOT_FOUND]: {
    status: HttpStatus.NOT_FOUND,
    message: 'Supplier not found',
  },

  // User
  [ErrorCode.USER_PHONE_EXISTS]: {
    status: HttpStatus.CONFLICT,
    message: 'User with this phone number already exists',
  },
};

// Maps an HTTP status to the generic code the exception filter falls back to
// for any HttpException that wasn't thrown as an AppException (guards, pipes,
// or not-yet-migrated throws).
export function genericCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ErrorCode.BAD_REQUEST;
    case HttpStatus.UNAUTHORIZED:
      return ErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return ErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
  }
}
