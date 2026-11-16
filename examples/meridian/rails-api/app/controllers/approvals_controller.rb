class ApprovalsController < ApplicationController
  def index
    approvals = policy_scope(Approval)
    render json: approvals
  end

  def show
    approval = Approval.find(params[:id])
    authorize approval
    render json: approval
  end

  def create
    expense = Expense.find(params[:expense_id])
    approval = expense.approvals.new(approver: current_user, status: :approved, note: params[:note])
    authorize approval

    return render json: { error: "Expense already approved" }, status: :conflict if expense.approved?

    approval.save!
    expense.approve!(current_user)

    render json: approval, status: :created
  end

  def update
    approval = Approval.find(params[:id])
    authorize approval

    if approval.update(status: params[:status], note: params[:note])
      render json: approval
    else
      render json: { errors: approval.errors.full_messages }, status: :unprocessable_entity
    end
  end
end
