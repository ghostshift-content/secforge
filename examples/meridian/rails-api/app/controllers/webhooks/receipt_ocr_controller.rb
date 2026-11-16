class Webhooks::ReceiptOcrController < ApplicationController
  skip_before_action :authenticate_user!

  def create
    expense = Expense.find(params[:expense_id])
    receipt = expense.receipt || expense.build_receipt(file_url: params[:file_url])

    receipt.assign_attributes(
      file_url: params[:file_url] || receipt.file_url,
      vendor_name: params[:vendor_name],
      ocr_amount_cents: params[:amount_cents],
      ocr_status: :processed,
      ocr_processed_at: Time.current
    )
    receipt.save!

    head :ok
  end
end
