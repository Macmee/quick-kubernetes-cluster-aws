# What does this do?

This is a CDK stack that quickly gets you setup with a kubernetes cluster, repo, autoscaler on AWS!

# What to configure

There are a number of things you can configure in index.ts

1. `clusterName` to change the name of the cluster
2. kubernetes version: currently CDK supports up to 1.21. Make sure to change both `eks.KubernetesVersion.V1_21` and `autoscalerImageTag`. The image tag is used for the autoscaler-deployment so search through [releases here](https://github.com/kubernetes/autoscaler/releases) i.e. "1.21" to find the correct tag for your kubernetes version.
3. the EC2 instance/family. I have it set to graviton3 right now. Due to a quirk with CDK you have to change both `instanceTypes` and `amiType` for it to work. If you aren't using a graviton/arm64 instance just remove `amiType` altogether.
4. for the autoscaler you can of course change `minSize` and `maxSize` and probably you should because my current configuration here has a max size of 80!
5. the maximum retention time for images in the repository. I have it set to `365` day image retention but you can change it to anything you want or simply comment out that line for images to live forever.

# Autoscaler

When you deploy an EKS cluster you have to manually deploy the autoscaler-deployment yourself, otherwise your ASG wont add or subtract nodes to your kubernetes cluster when you add or remove pods and other resources. There are a lot of manual steps to do this, so I added them to this CDK stack.

It works for now, but Amazon/Kubernetes update the autoscaler-deployment over time, so I think in the future it might break. If it does, I suggest [reading the AWS documentation here](https://docs.aws.amazon.com/eks/latest/userguide/autoscaling.html) and diffing their YAML file converted to JSON with the JSON manifest in this repo to see what to changed.

Alternatively I just learned about [Karpenter](https://github.com/aws/karpenter) which might be a better alternative to the autoscaler-deploymment on its own and which AWS created themselves! You could comment out the autoscale stuff in `index.ts` (step 5) and just set this up instead.

# Instructions

1. edit the variables in `index.ts` as you want.
2. in `package.json` change `--profile dev` to whichever `awscli` profile you use with your account, or just remove `--profile dev` altogether if you dont have multiple accounts setup. I hard coded it to this for safety.
3. run `npm run deploy` which will build and deploy the stack!
4. once the cloudformation is done it will print out a line like this:
`aws eks update-kubeconfig --name x-x --region us-east-1 --role-arn arn:aws:iam::x:role/x-x-x-cdk-d-x-x` and you can run this command to generate a kubeconfig file. Prefix the command with `KUBECONFIG=~/some/other/path` if you want it to write the kubeconfig to its own file instead of adding a context to your existing kubeconfig
5. You will need to login to the docker repo that this stack makes too. The stack should log an `accessKeyId` as well as a `secretAccessKey`. Run `aws configure --profile test-runner-repo-user` and login with that key.
6. then run this to login to that repo:

```
ACCOUNT_ID=<PUT YOUR AWS ACCOUNT ID HERE>
REGION=us-east-1
AWS_CLI_PROFILE=test-runner-repo-user

aws ecr get-login-password --region $REGION --profile $AWS_CLI_PROFILE | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
```

And that's it. You should now have a kubernetes cluster that autoscales, along with a repo the cluster can talk to and that you can too to push/pull images!
