class ReimbursementsController < ApplicationController
  before_action :ensure_finance!

  def index
    reimbursements = Reimbursement.joins(expense: :team).where(teams: { organization_id: current_user.organization_id })
    render json: reimbursements
  end

  def show
    reimbursement = Reimbursement.joins(expense: :team)
                                  .where(teams: { organization_id: current_user.organization_id })
                                  .find(params[:id])
    render json: reimbursement
  end

  def create
    expense = Expense.joins(:team).where(teams: { organization_id: current_user.organization_id }).find(params[:expense_id])
    reimbursement = expense.build_reimbursement(reimbursement_params)

    if reimbursement.save
      render json: reimbursement, status: :created
    else
      render json: { errors: reimbursement.errors.full_messages }, status: :unprocessable_entity
    end
  end

  private

  def ensure_finance!
    return if current_user.admin? || current_user.manager?

    render json: { error: "You are not authorized to perform this action" }, status: :forbidden
  end

  def reimbursement_params
    params.require(:reimbursement).permit(:amount_cents, :status)
  end
end
