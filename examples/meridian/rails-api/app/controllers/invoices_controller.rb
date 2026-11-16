class InvoicesController < ApplicationController
  before_action :ensure_finance!

  def index
    render json: current_user.organization.invoices
  end

  def show
    invoice = Invoice.where(id: params[:id], organization_id: current_user.organization_id).first!
    render json: invoice
  end

  def create
    invoice = current_user.organization.invoices.new(invoice_params)

    if invoice.save
      render json: invoice, status: :created
    else
      render json: { errors: invoice.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def update
    invoice = Invoice.where(id: params[:id], organization_id: current_user.organization_id).first!

    if invoice.update(invoice_params)
      render json: invoice
    else
      render json: { errors: invoice.errors.full_messages }, status: :unprocessable_entity
    end
  end

  private

  def ensure_finance!
    return if current_user.admin? || current_user.manager?

    render json: { error: "You are not authorized to perform this action" }, status: :forbidden
  end

  def invoice_params
    params.require(:invoice).permit(:invoice_number, :amount_cents, :due_date, :status)
  end
end
