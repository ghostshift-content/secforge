class ExpensesController < ApplicationController
  before_action :set_expense, only: [:show, :update, :destroy, :submit]

  def index
    expenses = policy_scope(Expense)
    render json: expenses
  end

  def show
    authorize @expense
    render json: @expense
  end

  def create
    expense = current_user.expenses.new(expense_params)
    authorize expense

    if expense.save
      render json: expense, status: :created
    else
      render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def update
    authorize @expense

    if @expense.update(expense_params)
      render json: @expense
    else
      render json: { errors: @expense.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    authorize @expense
    @expense.destroy
    head :no_content
  end

  def submit
    authorize @expense
    @expense.update!(status: :pending)
    render json: @expense
  end

  def download_receipt
    expense = Expense.find(params[:id])
    receipt = expense.receipt

    return render json: { error: "No receipt on file" }, status: :not_found if receipt.nil?

    redirect_to receipt.file_url
  end

  private

  def set_expense
    @expense = current_user.expenses.find(params[:id])
  end

  def expense_params
    params.require(:expense).permit(:description, :amount_cents, :incurred_on, :category)
  end
end
